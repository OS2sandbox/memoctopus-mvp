#!/usr/bin/env bash
# Opens an SSH tunnel to the self-hosted pyannote diarization service so the local
# dev server can reach it at DIARIZATION_URL (typically http://localhost:5000).
#
# Connection details live in .env (gitignored), NOT in package.json, because the
# GPU host is ephemeral and per-developer:
#   DIARIZATION_SSH=-p <port> user@host    # ssh target (host + port + any opts)
#   DIARIZATION_TUNNEL=5000:localhost:5000 # -L forward (optional; this is the default)
#
# Started by `npm run dev` via concurrently. It stays alive and auto-reconnects so a
# dropped tunnel doesn't take down the dev server (concurrently runs with --kill-others).
# When DIARIZATION_SSH is unset it idles quietly, so `npm run dev` works unchanged for
# anyone who hasn't set up the tunnel.
set -u

# Pull just the two keys we need out of .env (avoids sourcing the whole file).
read_env() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

SSH_TARGET="${DIARIZATION_SSH:-$(read_env DIARIZATION_SSH)}"
FORWARD="${DIARIZATION_TUNNEL:-$(read_env DIARIZATION_TUNNEL)}"
FORWARD="${FORWARD:-5000:localhost:5000}"

if [ -z "$SSH_TARGET" ]; then
  echo "[diar-tunnel] DIARIZATION_SSH not set in .env — skipping diarization tunnel."
  exec tail -f /dev/null   # stay alive so concurrently --kill-others isn't triggered
fi

echo "[diar-tunnel] forwarding -L $FORWARD via 'ssh $SSH_TARGET' (auto-reconnect)"

# Kill the child ssh when this script is signalled (Ctrl+C / concurrently shutdown)
# so the tunnel doesn't orphan and keep port ${FORWARD%%:*} held.
ssh_pid=""
cleanup() { [ -n "$ssh_pid" ] && kill "$ssh_pid" 2>/dev/null; exit 0; }
trap cleanup INT TERM EXIT

while true; do
  # shellcheck disable=SC2086 — SSH_TARGET intentionally word-splits (host + flags)
  ssh $SSH_TARGET -N -L "$FORWARD" \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new &
  ssh_pid=$!
  wait "$ssh_pid"
  echo "[diar-tunnel] tunnel closed; reconnecting in 3s…"
  sleep 3
done
