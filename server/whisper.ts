// Voice transcription router.
//
// Two backends, primary + fallback:
//
//   * Groq whisper-large-v3 (HTTP, hosted) — primary path. Better accuracy
//     than the local `medium` model, ~10–30× faster, practically free.
//     Implemented in `server/groq-whisper.ts`.
//
//   * Local FastAPI sidecar (faster-whisper, `whisper-service/`) — fallback
//     when the Groq call errors out. Same shape as before — Node POSTs
//     `{ url }` to `WHISPER_URL`, the sidecar downloads + transcribes.
//
// Either path may be configured independently:
//   - GROQ_API_KEY only        → Groq, no fallback (errors surface as-is)
//   - WHISPER_URL only         → sidecar (legacy behavior, no change)
//   - both                     → Groq first, sidecar on Groq error
//   - neither                  → throws WhisperNotConfiguredError so the
//                                Telegram handler can tell the user the
//                                feature isn't enabled instead of timing out.

import { GroqWhisperError, isGroqConfigured, transcribeViaGroq } from "./groq-whisper.js";

// faster-whisper on CPU is slow for long voice notes. Five minutes is a
// generous upper bound for `medium` on a 4 vCPU box transcribing a 10-minute
// clip. Groq has its own (much shorter) timeout in groq-whisper.ts.
const SIDECAR_TIMEOUT_MS = 5 * 60 * 1000;

export interface TranscribeResult {
  text: string;
  language?: string;
  duration?: number;
}

// Distinct error type so callers can distinguish "feature not enabled" from
// "feature is enabled but every backend failed".
export class WhisperNotConfiguredError extends Error {
  constructor() {
    super(
      "Voice transcription is disabled — set GROQ_API_KEY or WHISPER_URL to enable.",
    );
    this.name = "WhisperNotConfiguredError";
  }
}

function isSidecarConfigured(): boolean {
  return Boolean(process.env.WHISPER_URL?.trim());
}

export async function transcribeVoice(downloadUrl: string): Promise<TranscribeResult> {
  const groqOk = isGroqConfigured();
  const sidecarOk = isSidecarConfigured();

  if (!groqOk && !sidecarOk) {
    throw new WhisperNotConfiguredError();
  }

  // Try Groq first when available.
  if (groqOk) {
    try {
      const out = await transcribeViaGroq(downloadUrl);
      console.log(
        `[whisper] groq ok (lang=${out.language ?? "?"} dur=${out.duration ?? "?"}s chars=${out.text.length})`,
      );
      return out;
    } catch (err) {
      const reason = err instanceof GroqWhisperError ? err.message : String(err);
      if (sidecarOk) {
        console.warn(
          `[whisper] groq failed (${reason}) — falling back to local sidecar`,
        );
      } else {
        // No fallback configured. Surface the original error so the Telegram
        // handler logs it and tells the user voice transcription is broken
        // rather than disabled.
        console.error(`[whisper] groq failed and no sidecar fallback: ${reason}`);
        throw err;
      }
    }
  }

  // Fallback (or sole backend): the legacy sidecar at WHISPER_URL.
  return transcribeViaSidecar(downloadUrl);
}

async function transcribeViaSidecar(downloadUrl: string): Promise<TranscribeResult> {
  const endpoint = process.env.WHISPER_URL?.trim();
  if (!endpoint) {
    // Should be unreachable — caller gates on isSidecarConfigured() — but
    // keep the explicit check so the type is honest.
    throw new WhisperNotConfiguredError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: downloadUrl }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`whisper sidecar ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as TranscribeResult;
    if (!json || typeof json.text !== "string") {
      throw new Error("whisper sidecar returned an unexpected payload shape");
    }
    console.log(
      `[whisper] sidecar ok (lang=${json.language ?? "?"} dur=${json.duration ?? "?"}s chars=${json.text.length})`,
    );
    return json;
  } finally {
    clearTimeout(timer);
  }
}
