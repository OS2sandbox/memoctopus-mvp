FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install everything in one pass so pip resolves torch only once
# (nemo/pyannote may pull a newer torch than the cu124 index default,
#  a two-step install causes a double download that can exhaust disk)
RUN pip install --no-cache-dir \
    'nemo_toolkit[asr]' \
    'pyannote.audio' \
    fastapi \
    'uvicorn[standard]' \
    python-multipart \
    --extra-index-url https://download.pytorch.org/whl/cu124

COPY main.py .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
