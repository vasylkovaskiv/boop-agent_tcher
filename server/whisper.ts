// Thin client around the Whisper transcription sidecar (see whisper-service/).
//
// The sidecar exposes POST /transcribe { url } -> { text, language?, duration? }
// where `url` is a temporary download URL (e.g. api.telegram.org/file/...).
// The sidecar downloads the file itself so the Node process never holds the
// audio in memory.
//
// Voice transcription is opt-in: set WHISPER_URL to point at the sidecar
// (e.g. http://127.0.0.1:9000/transcribe locally, or http://whisper:9000/transcribe
// inside the Docker network). With WHISPER_URL unset transcribeVoice throws
// WhisperNotConfiguredError, which the Telegram handler turns into a clear
// "voice transcription isn't enabled" reply rather than a confusing timeout.

// Whisper on CPU can be slow for long voice notes. Five minutes is a generous
// upper bound for `medium` model on a 4 vCPU box transcribing a 10-minute clip.
const WHISPER_TIMEOUT_MS = 5 * 60 * 1000;

export interface TranscribeResult {
  text: string;
  language?: string;
  duration?: number;
}

// Distinct error type so callers can distinguish "feature not enabled" from
// "feature is enabled but the sidecar is unreachable / failing".
export class WhisperNotConfiguredError extends Error {
  constructor() {
    super("WHISPER_URL is not configured — voice transcription is disabled.");
    this.name = "WhisperNotConfiguredError";
  }
}

export async function transcribeVoice(downloadUrl: string): Promise<TranscribeResult> {
  const endpoint = process.env.WHISPER_URL?.trim();
  if (!endpoint) {
    throw new WhisperNotConfiguredError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
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
    return json;
  } finally {
    clearTimeout(timer);
  }
}
