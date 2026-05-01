FROM python:3.11-slim

WORKDIR /app

# ffmpeg is required by faster-whisper to decode ogg/opus (Telegram voice
# messages) and any other non-WAV input.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

ENV PYTHONUNBUFFERED=1
EXPOSE 9000

# Cache the downloaded faster-whisper model under /models so the container
# can be restarted without re-downloading. docker-compose.yml mounts a named
# volume here.
ENV HF_HOME=/models
ENV XDG_CACHE_HOME=/models

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9000/health', timeout=3).status==200 else 1)"

# Single-worker uvicorn — the model is held in memory once and we don't want
# the OS to spawn N copies of it. Concurrency comes from asyncio + the
# `_transcribe_sync` thread offload inside app.py.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000", "--workers", "1"]
