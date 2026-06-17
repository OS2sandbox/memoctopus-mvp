#!/bin/sh
# Open and maintain an SSH local-forward so sibling compose services can reach a
# remote loopback-only service. autossh re-establishes the tunnel if it drops.
#
# Config (env):
#   DIARIZATION_SSH    ssh target + flags, e.g. "-p 40419 root@1.2.3.4"   (required)
#   TUNNEL_LISTEN_PORT port this container listens on (default 5000)
#   TUNNEL_REMOTE      host:port to forward to, as seen from the ssh host
#                      (default localhost:5000 — the box's own diarization)
# Auth: mount a key dir at /host-ssh (id_* keys are copied in with safe perms),
#       or forward the host ssh-agent (set SSH_AUTH_SOCK + mount the socket).
set -eu

: "${DIARIZATION_SSH:?Set DIARIZATION_SSH, e.g. \"-p 40419 root@host\"}"
LISTEN_PORT="${TUNNEL_LISTEN_PORT:-5000}"
REMOTE="${TUNNEL_REMOTE:-localhost:5000}"

mkdir -p /root/.ssh && chmod 700 /root/.ssh
# Copy mounted private keys to a private, correctly-permissioned location — the
# bind mount is read-only and its perms/owner may not satisfy ssh's strict checks.
if [ -d /host-ssh ]; then
  for k in /host-ssh/id_*; do
    [ -e "$k" ] || continue
    case "$k" in *.pub) continue ;; esac
    cp "$k" "/root/.ssh/$(basename "$k")" && chmod 600 "/root/.ssh/$(basename "$k")"
  done
fi

echo "[diar-tunnel] forwarding 0.0.0.0:${LISTEN_PORT} -> ${REMOTE} via 'ssh ${DIARIZATION_SSH}'"

# DIARIZATION_SSH intentionally word-splits into ssh flags + target.
# shellcheck disable=SC2086
exec autossh -M 0 -N \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L "0.0.0.0:${LISTEN_PORT}:${REMOTE}" \
  ${DIARIZATION_SSH}
