// Thin client around the Whisper transcription sidecar (see whisper-service/).
//
// The sidecar exposes POST /transcribe { url } -> { text, language?, duration? }
// where `url` is a temporary download URL (e.g. api.telegram.org/file/...).
// The sidecar downloads the file itself so the Node process never holds the
// audio in memory.
//
// In dev (no Whisper running) WHISPER_URL can be left unset — transcribeVoice
// will throw a clearly-labelled error and the Telegram handler will reply with
// a friendly fallback message.

const DEFAULT_WHISPER_URL = "http://127.0.0.1:9000/transcribe";
// Whisper on CPU can be slow for long voice notes. Five minutes is a generous
// upper bound for `medium` model on a 4 vCPU box transcribing a 10-minute clip.
const WHISPER_TIMEOUT_MS = 5 * 60 * 1000;

export interface TranscribeResult {
  text: string;
  language?: string;
  duration?: number;
}

export async function transcribeVoice(downloadUrl: string): Promise<TranscribeResult> {
  const endpoint = process.env.WHISPER_URL?.trim() || DEFAULT_WHISPER_URL;
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
