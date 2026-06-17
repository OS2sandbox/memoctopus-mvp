# pyannote.audio speaker diarization service.
# CUDA runtime base so the pipeline can use the host GPU (via nvidia-container-toolkit).
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app.py .

# Bake the gated model weights into the image so the service runs fully offline at
# request time. Pass the HF token only at build:
#   docker build --build-arg HF_TOKEN=hf_xxx -t diarization-service ./diarization-service
# (You must first accept the model terms on huggingface.co for the model.)
#
# Set BAKE_WEIGHTS=false to skip the download — the service then loads the weights
# at runtime from a mounted HF cache ($HF_HOME=/models) using a runtime HF_TOKEN.
ARG HF_TOKEN
ARG BAKE_WEIGHTS=true
RUN if [ "$BAKE_WEIGHTS" = "true" ]; then \
      python3 -c "from pyannote.audio import Pipeline; \
        Pipeline.from_pretrained('pyannote/speaker-diarization-community-1', use_auth_token='${HF_TOKEN}')"; \
    else \
      echo "BAKE_WEIGHTS=false — skipping build-time model download (weights expected at runtime via mounted /models)"; \
    fi

EXPOSE 5000

# Single worker: the pipeline holds the model in memory and is GPU-bound, so
# concurrency is handled by batching one recording at a time, not multiple workers.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
