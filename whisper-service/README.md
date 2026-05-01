# whisper-service

Self-hosted Whisper sidecar for boop-agent's Telegram voice transcription.

## What it is

A tiny FastAPI app wrapping [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
The boop-agent Node process POSTs `{ url }` of the Telegram voice file here;
the sidecar downloads it, runs Whisper, and returns plain text.

```
POST /transcribe   { "url": "https://api.telegram.org/file/bot.../voice.oga" }
                ─► { "text": "...", "language": "ru", "duration": 12.4 }

GET  /health      ─► { "ok": true, "model": "medium", ... }
```

## Why a separate process

- Whisper-class models pin a non-trivial chunk of RAM (1–5 GB depending on
  size). Crashing them shouldn't take the agent down.
- faster-whisper is Python-native; running it in-process via Node bindings
  is fragile and slower.
- Independent restart, independent resource limits in `docker-compose.yml`.

## Configuration

All via environment variables (see `app.py`):

| Var | Default | Notes |
|---|---|---|
| `WHISPER_MODEL` | `medium` | One of `tiny` / `base` / `small` / `medium` / `large-v3` |
| `WHISPER_DEVICE` | `cpu` | Set to `cuda` if you have a GPU |
| `WHISPER_COMPUTE` | `int8` | `int8` is the right pick on CPU; `float16` on GPU |
| `WHISPER_LANGUAGE` | unset | ISO code (`ru`, `en`, …). Empty = autodetect |
| `WHISPER_BEAM_SIZE` | `1` | Bigger = better quality, slower |
| `WHISPER_DOWNLOAD_TIMEOUT` | `60` | Seconds to fetch the source URL |

## Running locally (without Docker)

```bash
cd whisper-service
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
sudo apt install -y ffmpeg
WHISPER_MODEL=small uvicorn app:app --host 127.0.0.1 --port 9000
```

The first request will download model weights to `~/.cache/huggingface/`
(~500 MB for `medium`). They're cached for subsequent runs — in Docker
Compose this is mapped to a named volume so models survive container
rebuilds.

## Memory footprint

| Model | RAM | Speed on 4 vCPU CPU |
|---|---|---|
| `small` | ~1 GB | ~5× realtime |
| `medium` | ~2.5 GB | ~2× realtime |
| `large-v3` | ~5 GB | ~0.5× realtime |

For a 7.6 GB VPS with Boop alongside, `medium` is the sweet spot.
