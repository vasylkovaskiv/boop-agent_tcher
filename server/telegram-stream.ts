// Native streaming via Telegram's sendMessageDraft (Bot API 9.5+, March 2026).
//
// Why drafts instead of editMessageText?
//   - sendMessage + editMessageText sends a notification on the first message,
//     adds the "edited" tag to the final, and is rate-limited at ~1 update/s.
//   - sendMessageDraft is purpose-built for AI streaming: no notification, no
//     "edited" tag, higher refresh rate. Drafts auto-disappear when the bot
//     finally calls sendMessage (which "commits" the draft into a real message).
//
// Limitations:
//   - sendMessageDraft is only valid for *private* chats. We only stream when
//     the chat id is positive (private chat); group chats fall through to a
//     no-op stream that defers everything to a single sendMessage at finalize.
//   - Older bot clients silently ignore drafts. flushDraft swallows errors so
//     the worst case is "no streaming visible, message arrives at the end".
//
// Toggle behaviour with TELEGRAM_STREAMING:
//   "true"  / unset → streaming on (default)
//   "false"          → streaming off (legacy single-shot sendMessage)
import { getBot, sendTelegramMessage } from "./telegram.js";

const DEBOUNCE_MS = 800;
// Telegram tolerates fast updates on drafts but starts coalescing animation
// frames if you go below ~1s. Empirically 1000ms gives a smooth typewriter
// without stuttering.
const MIN_INTERVAL_MS = 1000;
const MAX_DRAFT_LEN = 4000;

export interface DraftStream {
  /** Append generated chunk; debounces and pushes the cumulative buffer. */
  push(chunk: string): void;
  /** Discard the current draft buffer (e.g. when a new assistant turn starts
   *  so pre-tool-call narration doesn't leak into the final message). */
  reset(): void;
  /** Commit the final text as a real Telegram message. Replaces the draft. */
  finalize(text: string): Promise<void>;
  /** Tear down without sending anything. Used when the caller already sent
   *  the message itself or the turn errored irrecoverably. */
  abort(): void;
}

function streamingEnabled(): boolean {
  const flag = (process.env.TELEGRAM_STREAMING ?? "true").toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "off";
}

function isPrivateChat(chatId: string): boolean {
  // Telegram convention: positive id => user, negative => group/channel.
  // Avoid passing groups to sendMessageDraft since the API rejects them.
  const n = Number(chatId);
  return Number.isFinite(n) && n > 0;
}

function noopStream(chatId: string): DraftStream {
  return {
    push() {},
    reset() {},
    async finalize(text: string) {
      await sendTelegramMessage(chatId, text);
    },
    abort() {},
  };
}

export function createDraftStream(chatId: string): DraftStream {
  if (!streamingEnabled() || !isPrivateChat(chatId)) {
    return noopStream(chatId);
  }

  const bot = getBot();
  // 30-bit non-zero id keeps us inside int32 range while avoiding the
  // forbidden zero. Per-stream so drafts from concurrent turns (rare but
  // possible if the user double-sends) don't animate into each other.
  const draftId = Math.floor(Math.random() * 0x3fff_ffff) + 1;
  const chatIdNum = Number(chatId);

  let buffer = "";
  let lastSentAt = 0;
  let lastSentText = "";
  let pendingTimer: NodeJS.Timeout | null = null;
  let aborted = false;
  let finalized = false;

  async function flushDraft(): Promise<void> {
    pendingTimer = null;
    if (aborted || finalized || buffer === "" || buffer === lastSentText) return;
    const text =
      buffer.length > MAX_DRAFT_LEN ? buffer.slice(0, MAX_DRAFT_LEN) : buffer;
    try {
      await bot.api.sendMessageDraft(chatIdNum, draftId, text);
      lastSentAt = Date.now();
      lastSentText = text;
    } catch (err) {
      // Most common failure: bot client predates Bot API 9.5, or the chat
      // is a group despite our isPrivateChat check (id format edge case).
      // Don't propagate — the final sendMessage in finalize() still works.
      console.error("[telegram-stream] sendMessageDraft failed:", err);
    }
  }

  function schedule(): void {
    if (pendingTimer) return;
    const elapsed = Date.now() - lastSentAt;
    const wait = elapsed >= MIN_INTERVAL_MS ? DEBOUNCE_MS : MIN_INTERVAL_MS - elapsed;
    pendingTimer = setTimeout(flushDraft, wait);
  }

  return {
    push(chunk: string) {
      if (aborted || finalized || !chunk) return;
      buffer += chunk;
      schedule();
    },
    reset() {
      if (aborted || finalized) return;
      buffer = "";
      // Don't push an empty draft frame — the user just sees the existing
      // animation freeze briefly until the next push() rebuilds the buffer.
      // Pushing "" triggers a Telegram error (text must be 1-4096 chars).
    },
    async finalize(text: string) {
      if (aborted || finalized) return;
      finalized = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      // sendMessage replaces the latest draft with a real message; no need to
      // clear the draft explicitly. sendTelegramMessage handles >4096 chunking.
      await sendTelegramMessage(chatId, text);
    },
    abort() {
      aborted = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
