import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { adminChatIdOrFallback, checkPerplexitySession } from "./perplexity-client.js";

// Cookie session refresh window. Perplexity's `__Secure-next-auth.session-
// token` lives ~7 days — checking every 6h with ±30 min jitter keeps us
// well within that window without hammering the auth endpoint.
const KEEP_ALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const JITTER_MS = 30 * 60 * 1000;
// First check after process start: short delay so an obviously broken cookie
// surfaces quickly in logs, but long enough that a cold start doesn't race
// with proxy / Convex client construction.
const INITIAL_DELAY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let lastAlertSentAt = 0;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h — don't spam Telegram

export function startPerplexityKeepAlive(): void {
  if (!process.env.ASOCKS_PROXY_URL) return;
  if (timer) return;
  scheduleNext(INITIAL_DELAY_MS);
  console.log("[perplexity] keep-alive scheduled");
}

export function stopPerplexityKeepAlive(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(delay?: number): void {
  const ms =
    delay ??
    KEEP_ALIVE_INTERVAL_MS + (Math.random() - 0.5) * 2 * JITTER_MS;
  timer = setTimeout(() => {
    void runCheck();
  }, ms);
  // Don't keep the event loop alive on this — bot startup/shutdown should
  // not be gated by an idle keep-alive timer.
  if (timer && typeof timer.unref === "function") timer.unref();
}

async function runCheck(): Promise<void> {
  try {
    const state = await convex.query(api.perplexity.getState, {});
    if (!state) {
      console.log("[perplexity] keep-alive: no state row, skipping");
      return;
    }
    const result = await checkPerplexitySession();
    if (result.ok) {
      console.log("[perplexity] keep-alive: ok");
      return;
    }
    if (result.status === 401 || result.status === 403) {
      console.warn(`[perplexity] keep-alive: cookies invalid (HTTP ${result.status})`);
      await convex.mutation(api.perplexity.recordFailure, {
        error: `keep-alive HTTP ${result.status}`,
      });
      await maybeAlertCookiesExpired(`HTTP ${result.status}`);
    } else {
      console.warn(`[perplexity] keep-alive: HTTP ${result.status}`);
    }
  } catch (err) {
    console.error("[perplexity] keep-alive error:", err);
  } finally {
    scheduleNext();
  }
}

async function maybeAlertCookiesExpired(reason: string): Promise<void> {
  const now = Date.now();
  if (now - lastAlertSentAt < ALERT_COOLDOWN_MS) return;
  const adminChatId = adminChatIdOrFallback();
  if (!adminChatId) {
    console.warn(
      "[perplexity] cookies-expired alert skipped — TELEGRAM_ADMIN_CHAT_ID not set and TELEGRAM_ALLOWED_CHAT_IDS empty",
    );
    return;
  }
  try {
    const { sendTelegramMessage } = await import("./telegram.js");
    await sendTelegramMessage(
      adminChatId,
      `⚠️ Perplexity cookies expired (${reason}).\nRun \`npm run refresh-perplexity-cookies -- --profile-id=<id>\` to update.`,
    );
    lastAlertSentAt = now;
  } catch (err) {
    console.error("[perplexity] failed to send keep-alive alert:", err);
  }
}
