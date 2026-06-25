#!/usr/bin/env bash
# Deploy the diarization service to the GPU box (the same host that runs hviske).
# Run from your Mac. Requires SSH access to the box and Docker installed there.
#
#   HF_TOKEN=hf_xxx DIARIZATION_API_KEY=secret ./deploy.sh user@109.173.238.203
#
# HF_TOKEN              — Hugging Face token with gated-repo read access (build-time only)
# DIARIZATION_API_KEY   — bearer secret the app uses to call the service
#                         (must match DIARIZATION_API_KEY in the app's .env)
set -euo pipefail

SSH_TARGET="${1:?Usage: HF_TOKEN=... DIARIZATION_API_KEY=... ./deploy.sh user@host}"
: "${HF_TOKEN:?Set HF_TOKEN (Hugging Face token with gated-repo read access)}"
: "${DIARIZATION_API_KEY:?Set DIARIZATION_API_KEY (must match the app .env)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="~/diarization-service"

echo "→ Copying service files to ${SSH_TARGET}:${REMOTE_DIR}"
ssh "$SSH_TARGET" "mkdir -p ${REMOTE_DIR}"
scp "$HERE/app.py" "$HERE/requirements.txt" "$HERE/Dockerfile" "$SSH_TARGET:${REMOTE_DIR}/"

echo "→ Building image on the box (downloads gated weights, can take several minutes)"
ssh "$SSH_TARGET" "cd ${REMOTE_DIR} && docker build --build-arg HF_TOKEN='${HF_TOKEN}' -t diarization-service ."

echo "→ (Re)starting container on port 5000"
ssh "$SSH_TARGET" "docker rm -f diarization-service 2>/dev/null || true; \
  docker run -d --name diarization-service --gpus all -p 5000:5000 \
    -e DIARIZATION_API_KEY='${DIARIZATION_API_KEY}' \
    --restart unless-stopped diarization-service"

echo "→ Waiting for health (model load can take ~60s on first boot)…"
for i in $(seq 1 30); do
  if ssh "$SSH_TARGET" "curl -sf http://localhost:5000/health >/dev/null"; then
    echo "✓ diarization-service is healthy on ${SSH_TARGET%@*}:5000"
    ssh "$SSH_TARGET" "curl -s http://localhost:5000/health"; echo
    exit 0
  fi
  sleep 5
done
echo "✗ Service did not become healthy in time — check: ssh ${SSH_TARGET} 'docker logs diarization-service'"
exit 1
