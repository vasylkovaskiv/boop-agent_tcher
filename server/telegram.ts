import express from "express";
import { Bot, type Context, GrammyError, HttpError } from "grammy";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { transcribeVoice } from "./whisper.js";

// Telegram Bot API limits a single sendMessage to 4096 chars. Leave a small
// safety margin so emojis/escapes don't push us over.
const MAX_CHUNK = 4000;

let cached: Bot | null = null;
let pollingStarted = false;

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather and put it in .env.local.",
    );
  }
  return token;
}

function getAllowList(): Set<string> {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function getBot(): Bot {
  if (cached) return cached;
  cached = new Bot(getToken());
  cached.catch((err) => {
    // grammy's global error handler — keeps the bot alive on per-update errors.
    if (err.error instanceof GrammyError) {
      console.error("[telegram] api error:", err.error.description);
    } else if (err.error instanceof HttpError) {
      console.error("[telegram] network error:", err.error.message);
    } else {
      console.error("[telegram] unhandled error:", err.error);
    }
  });
  return cached;
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Public: send plain text to a Telegram chat. The chatId is the numeric id
// extracted from the `tg:<chatId>` conversationId.
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const bot = getBot();
  for (const part of chunk(text)) {
    try {
      // No parse_mode — keep messages plain so we don't have to escape markdown
      // returned by sub-agents (URLs, code, etc.).
      await bot.api.sendMessage(chatId, part);
      console.log(`[telegram] → sent ${part.length} chars to ${chatId}`);
    } catch (err) {
      console.error(`[telegram] sendMessage to ${chatId} failed:`, err);
    }
  }
}

// Public: keep the "typing..." indicator alive. Telegram clears it after ~5s,
// so we re-send every 4s until the caller stops the loop.
export function startTypingLoop(chatId: string): () => void {
  const bot = getBot();
  const ping = () => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {
      /* non-fatal — chat may be closed/blocked mid-turn */
    });
  };
  ping();
  const timer = setInterval(ping, 4000);
  return () => clearInterval(timer);
}

function isAllowed(chatId: number | string, allow: Set<string>): boolean {
  // Empty allow-list is treated as "no restrictions" — convenient for local
  // dev. For production deployment the allow-list must be set; the README
  // and .env.example call this out.
  if (allow.size === 0) return true;
  return allow.has(String(chatId));
}

interface TelegramDedup {
  claim: (updateId: number) => Promise<boolean>;
}

// In-memory dedup is sufficient for long-polling (grammy advances offset
// before we process). For webhook mode Telegram retries on failure, but we
// always 200 the webhook before processing, so duplicates are extremely rare.
// Keep last 1000 update_ids to defend against a same-process retry burst.
function createInMemoryDedup(): TelegramDedup {
  const seen = new Set<number>();
  const order: number[] = [];
  const MAX = 1000;
  return {
    async claim(id: number): Promise<boolean> {
      if (seen.has(id)) return false;
      seen.add(id);
      order.push(id);
      if (order.length > MAX) {
        const drop = order.shift();
        if (drop !== undefined) seen.delete(drop);
      }
      return true;
    },
  };
}

const dedup: TelegramDedup = createInMemoryDedup();

interface InboundContent {
  text: string;
  // Whether the agent should be told the message was a transcribed voice note.
  // We surface this to the dispatcher prompt so it can adapt tone if needed.
  fromVoice: boolean;
}

async function extractInboundText(ctx: Context): Promise<InboundContent | null> {
  const msg = ctx.message;
  if (!msg) return null;

  const text = msg.text ?? msg.caption;
  if (text && text.trim()) return { text: text.trim(), fromVoice: false };

  const audio = msg.voice ?? msg.audio;
  if (audio) {
    try {
      const file = await ctx.api.getFile(audio.file_id);
      const path = file.file_path;
      if (!path) {
        console.warn("[telegram] getFile returned no file_path");
        return null;
      }
      const url = `https://api.telegram.org/file/bot${getToken()}/${path}`;
      const result = await transcribeVoice(url);
      const transcript = result.text.trim();
      if (!transcript) {
        await ctx.reply(
          "I couldn't make out anything in that voice note — sounded silent. Try again or send text.",
        );
        return null;
      }
      console.log(
        `[telegram] voice transcribed (${result.language ?? "?"}, ${result.duration ?? "?"}s): ${transcript.slice(0, 80)}…`,
      );
      return { text: transcript, fromVoice: true };
    } catch (err) {
      console.error("[telegram] whisper transcription failed:", err);
      await ctx.reply(
        "Couldn't transcribe that voice note — Whisper isn't reachable right now. Try sending text instead.",
      );
      return null;
    }
  }

  return null;
}

async function handleUpdate(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const update = ctx.update;
  if (!chat || !ctx.message) return;

  if (!(await dedup.claim(update.update_id))) {
    return;
  }

  const allow = getAllowList();
  if (!isAllowed(chat.id, allow)) {
    console.log(
      `[telegram] rejected message from chat ${chat.id} (not in TELEGRAM_ALLOWED_CHAT_IDS)`,
    );
    return;
  }

  const inbound = await extractInboundText(ctx);
  if (!inbound) return;

  const conversationId = `tg:${chat.id}`;
  const turnTag = Math.random().toString(36).slice(2, 8);
  const preview =
    inbound.text.length > 100 ? inbound.text.slice(0, 100) + "…" : inbound.text;
  console.log(
    `[turn ${turnTag}] ← ${chat.id}${inbound.fromVoice ? " (voice)" : ""}: ${JSON.stringify(preview)}`,
  );

  broadcast("message_in", {
    conversationId,
    content: inbound.text,
    from_number: String(chat.id),
    handle: String(update.update_id),
  });

  const stopTyping = startTypingLoop(String(chat.id));
  const start = Date.now();
  try {
    const reply = await handleUserMessage({
      conversationId,
      content: inbound.text,
      turnTag,
      onThinking: (t) => broadcast("thinking", { conversationId, t }),
    });
    if (reply) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
      console.log(
        `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
      );
      await sendTelegramMessage(String(chat.id), reply);
      await convex.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: reply,
      });
    } else {
      console.log(`[turn ${turnTag}] → (no reply)`);
    }
  } catch (err) {
    console.error(`[turn ${turnTag}] handler error`, err);
    await sendTelegramMessage(
      String(chat.id),
      "Something broke on my side. Try again in a minute — logs will have the details.",
    );
  } finally {
    stopTyping();
  }
}

// === Long-polling lifecycle ===
// Recommended for VPS deployments without a public URL. grammy maintains the
// getUpdates offset internally and retries on transient errors.
export async function startTelegramPolling(): Promise<void> {
  if (pollingStarted) return;
  const bot = getBot();
  bot.on("message", handleUpdate);
  // Don't await: bot.start() never resolves in long-polling mode.
  bot.start({
    drop_pending_updates: false,
    allowed_updates: ["message"],
    onStart: (info) => {
      pollingStarted = true;
      console.log(`[telegram] polling as @${info.username}`);
    },
  });
}

// === Webhook lifecycle ===
// Mount the router and set the webhook URL on Telegram's side. Use only when
// PUBLIC_URL is a stable HTTPS endpoint (e.g. behind Traefik with Let's
// Encrypt). See README's deployment section.
export function createTelegramWebhookRouter(): express.Router {
  const router = express.Router();
  const bot = getBot();
  bot.on("message", handleUpdate);
  router.post("/webhook", async (req, res) => {
    // Acknowledge immediately so Telegram doesn't retry on slow handlers.
    res.json({ ok: true });
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error("[telegram] webhook handler error", err);
    }
  });
  return router;
}

export async function registerTelegramWebhook(publicUrl: string): Promise<void> {
  const bot = getBot();
  const url = `${publicUrl.replace(/\/+$/, "")}/telegram/webhook`;
  await bot.api.setWebhook(url, {
    drop_pending_updates: false,
    allowed_updates: ["message"],
  });
  console.log(`[telegram] webhook registered at ${url}`);
}

export async function deleteTelegramWebhook(): Promise<void> {
  const bot = getBot();
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  console.log("[telegram] webhook deleted");
}
