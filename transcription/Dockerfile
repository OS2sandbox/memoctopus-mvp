FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Host driver 595.71.05 supports CUDA 13.x runtime. Use torch 2.8+cu128 wheels
# so pyannote.audio 4.x + torchcodec install cleanly.
RUN pip install --no-cache-dir \
    'torch==2.8.0' \
    'torchaudio==2.8.0' \
    --index-url https://download.pytorch.org/whl/cu128 && \
    pip install --no-cache-dir \
    nvidia-npp-cu12 \
    'pyannote.audio' \
    'torchcodec==0.7' \
    'httpx<0.28' \
    soundfile \
    numpy \
    fastapi \
    'uvicorn[standard]' \
    python-multipart \
    --extra-index-url https://download.pytorch.org/whl/cu128

# Expose nvidia-npp-cu12's .so files to ctypes/torchcodec (torch only preloads
# the CUDA libs it uses directly; torchcodec's audio decoder needs NPP too).
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/npp/lib:${LD_LIBRARY_PATH}

COPY main.py .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
