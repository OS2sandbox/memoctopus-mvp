#!/bin/bash
set -e

# Start a virtual X framebuffer so the bot can run Chromium with
# `headless: false`. Teams' anti-bot heuristics detect headless mode
# (even Chrome's new headless) and produce post-admission "Leaving..."
# cascades — running headed against Xvfb sidesteps the detection.
# The display number :99 matches the DISPLAY env var set in the Dockerfile.
echo "[entrypoint] starting Xvfb on :99"
Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR +extension GLX &
XVFB_PID=$!

# Wait briefly for Xvfb to be ready — exec'ing node immediately can race
# the X server initialisation and Chromium fails to find the display.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "[entrypoint] Xvfb ready (attempt $i)"
    break
  fi
  sleep 0.2
done

# Propagate SIGTERM so docker stop drains sessions cleanly via the Node side.
trap 'kill -TERM $NODE_PID 2>/dev/null; wait $NODE_PID 2>/dev/null; kill $XVFB_PID 2>/dev/null; exit 0' TERM INT

node dist/index.js &
NODE_PID=$!
wait $NODE_PID
