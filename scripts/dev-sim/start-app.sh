#!/usr/bin/env bash
# Starts the Next.js dev server wired to the simulation stack (scripts/dev-sim/index.ts must
# be running). Only Next.js starts; the Teams bot and diarisation tunnel are not needed.
#   scripts/dev-sim/start-app.sh
# Mode switch (optional): SIM_ACCESS_SOURCE=local starts the same app in local mode.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
npx tsx scripts/dev-sim/index.ts --env > "$ENV_FILE"
set -a; . "$ENV_FILE"; set +a
if [ -n "${SIM_ACCESS_SOURCE:-}" ]; then export ACCESS_SOURCE="$SIM_ACCESS_SOURCE"; fi
exec ./node_modules/.bin/next dev -p "${PORT:-3004}"
