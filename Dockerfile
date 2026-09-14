# Shikigami Protocol — Docker image (server-only, no Electron)
# Usage: docker compose up  OR  docker build -t shikigami . && docker run -p 7788:7788 shikigami

FROM python:3.12-slim

# System deps:
#   gcc / build-essential  — native extensions (chromadb, tokenizers)
#   libsndfile1            — soundfile (TTS / STT audio I/O)
#   ffmpeg                 — DH 数字人格式兜底：dh_audio.to_dh_wav 第三级转码
#                            （soundfile 解不了的音频源 → 16k/mono/PCM16 WAV）
#   curl                   — healthcheck
#   git                    — some pip packages fetch via git
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        build-essential \
        libsndfile1 \
        ffmpeg \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- dependency layer (cached unless requirements.txt changes) ---
COPY requirements.txt .
COPY requirements-ai.txt .
RUN pip install --no-cache-dir -r requirements.txt kokoro-onnx "misaki[zh]"  sherpa-onnx


# --- application code ---
COPY . .

EXPOSE 7788
ENV PYTHONUNBUFFERED=1 PYTHONUTF8=1

# Healthcheck — server takes a few seconds to start
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:7788/version || exit 1

CMD ["python", "server.py"]
