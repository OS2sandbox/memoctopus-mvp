FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Host driver 550.x only supports CUDA 12.4 — cu124 index only has torch<=2.6.
# pyannote 4.x needs torchaudio>=2.8 (unavailable for cu124), so pin to 3.x.
# Use constraints to prevent the second pip install from upgrading torch.
RUN echo 'torch==2.6.0+cu124' > /tmp/constraints.txt && \
    echo 'torchaudio==2.6.0+cu124' >> /tmp/constraints.txt && \
    pip install --no-cache-dir \
    'torch==2.6.0+cu124' \
    'torchaudio==2.6.0+cu124' \
    --index-url https://download.pytorch.org/whl/cu124 && \
    pip install --no-cache-dir \
    --constraint /tmp/constraints.txt \
    'nemo_toolkit[asr]' \
    'pyannote.audio>=3.3,<4.0' \
    fastapi \
    'uvicorn[standard]' \
    python-multipart \
    --extra-index-url https://download.pytorch.org/whl/cu124

COPY main.py .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
