// Groq-hosted whisper-large-v3 transcription path.
//
// Whisper transcription has two backends: Groq's hosted whisper-large-v3 (this
// file, primary path) and the local FastAPI sidecar in `whisper-service/`
// (fallback). The router that picks between them lives in `server/whisper.ts`.
//
// Why Groq is the primary:
//   * whisper-large-v3 is materially better than the local `medium` model,
//     especially for accented Russian / English code-switching.
//   * Groq's inference is ~10–30× faster than CPU faster-whisper. Telegram
//     voice notes typically transcribe in 1–3 s vs. 7–30 s locally.
//   * Practically free for our volume (the model is in Groq's free-tier audio
//     budget; even paid pricing is ~$0.04 / hour of audio).
//
// Falls back to the sidecar on any error (network, 5xx, expired key, etc.).
// We wrap failures in `GroqWhisperError` so the router can branch on error
// type if it ever needs to.
//
// We deliberately avoid the `groq-sdk` package — the API is a single
// multipart POST and pulling in a new dep just for that would be silly.

import type { TranscribeResult } from "./whisper.js";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";

// Groq is fast: a 60-second voice note finishes in ~2–4 s. Give ourselves
// generous slack for ingest + network without holding the Telegram update
// open forever if Groq stalls.
const GROQ_TIMEOUT_MS = 60 * 1000;

// Telegram voice notes are capped at ~1.5 MB by the platform; Groq's audio
// endpoint accepts up to 25 MB on the free tier. We still bound the download
// defensively so a malicious or weird payload can't pin memory.
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export class GroqWhisperError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GroqWhisperError";
  }
}

interface GroqVerboseJson {
  text: string;
  language?: string;
  duration?: number;
}

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

export async function transcribeViaGroq(downloadUrl: string): Promise<TranscribeResult> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new GroqWhisperError("GROQ_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    // 1) Pull the file off Telegram's CDN. Telegram file links are valid for
    //    ~1 hour, which is plenty.
    const fileRes = await fetch(downloadUrl, { signal: controller.signal });
    if (!fileRes.ok) {
      throw new GroqWhisperError(
        `failed to download audio from Telegram: ${fileRes.status}`,
        fileRes.status,
      );
    }
    const audioBuf = await fileRes.arrayBuffer();
    if (audioBuf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new GroqWhisperError(
        `audio payload too large: ${audioBuf.byteLength} bytes`,
      );
    }

    // 2) Multipart POST to Groq. `verbose_json` gives us language + duration
    //    in the same shape the local sidecar already returns, so the
    //    downstream Telegram log line stays unchanged.
    const filename = inferFilename(downloadUrl);
    const form = new FormData();
    form.append("file", new Blob([audioBuf]), filename);
    form.append("model", GROQ_MODEL);
    form.append("response_format", "verbose_json");
    // No `language` field: Groq autodetects, same as local sidecar default.

    const groqRes = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!groqRes.ok) {
      const body = await groqRes.text().catch(() => "");
      throw new GroqWhisperError(
        `groq ${groqRes.status}: ${body.slice(0, 500)}`,
        groqRes.status,
      );
    }
    const json = (await groqRes.json()) as GroqVerboseJson;
    if (!json || typeof json.text !== "string") {
      throw new GroqWhisperError("groq returned unexpected payload shape");
    }
    return {
      text: json.text,
      language: json.language,
      duration: json.duration,
    };
  } catch (err) {
    if (err instanceof GroqWhisperError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GroqWhisperError(`groq request timed out after ${GROQ_TIMEOUT_MS}ms`);
    }
    throw new GroqWhisperError(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

// Groq's audio endpoint sniffs container type by filename extension and
// rejects anything outside this allowlist with HTTP 400. Notably absent:
// `.oga`, which Telegram uses for voice notes (Ogg/Opus, same container as
// `.ogg` but a different file extension). We normalise unknown extensions
// to `.ogg` since Telegram voice notes always are Ogg/Opus.
const GROQ_ALLOWED_EXTENSIONS = new Set([
  "flac",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "ogg",
  "opus",
  "wav",
  "webm",
]);

function inferFilename(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() ?? "";
    const m = /\.([a-zA-Z0-9]{2,5})$/.exec(last);
    if (m) {
      const ext = m[1].toLowerCase();
      if (GROQ_ALLOWED_EXTENSIONS.has(ext)) return last;
      // Telegram voice → `.oga` (Ogg/Opus). Audio uploads can be anything.
      // Either way, when in doubt, claim Ogg — the actual bytes will be
      // sniffed by ffmpeg behind Groq's API and an Opus-in-Ogg stream
      // decodes regardless.
    }
  } catch {
    // ignore, fall through
  }
  return "audio.ogg";
}
