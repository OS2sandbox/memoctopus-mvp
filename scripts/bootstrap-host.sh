#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu/Debian GPU host for the Referat stack:
#   installs Docker Engine + compose plugin + the NVIDIA Container Toolkit,
#   verifies GPU passthrough, then (optionally) brings the stack up.
#
# Run ON the host, from the repo root, as root or a sudo-capable user:
#   ./scripts/bootstrap-host.sh                 # install + verify GPU + compose up (everything)
#   ./scripts/bootstrap-host.sh --no-up         # install + verify only, don't start anything
#   ./scripts/bootstrap-host.sh --small         # base stack only (no GPU services / toolkit)
#
# Assumes the NVIDIA *driver* is already present (`nvidia-smi` works). It does NOT
# install kernel drivers — on cloud GPU images the driver is preinstalled. If you
# need the driver, install it first (e.g. `ubuntu-drivers autoinstall`) and reboot.
set -euo pipefail

MODE=everything   # everything | small
DO_UP=1

for arg in "$@"; do
  case "$arg" in
    --small)      MODE=small ;;
    --everything) MODE=everything ;;
    --no-up)      DO_UP=0 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $arg (try --help)"; exit 2 ;;
  esac
done

# Run from the repo root (parent of this script's dir).
cd "$(dirname "$0")/.."

# Use sudo only when not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "✗ Need root or sudo."; exit 1; }
  SUDO="sudo"
fi

command -v apt-get >/dev/null 2>&1 || {
  echo "✗ This script targets Debian/Ubuntu (apt). Install Docker + nvidia-container-toolkit manually on other distros."; exit 1; }

log() { printf '\n\033[1;34m→ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker + compose already installed"; add_docker_group; return
  fi
  log "Installing Docker Engine + compose plugin"
  . /etc/os-release
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
  ok "Docker installed"
  add_docker_group
}

# Add the real (non-root) user to the docker group so the day-2 ops in DEPLOY.md
# work without sudo. Group membership only takes effect on a new login, so this
# run still uses $SUDO; we just print the heads-up.
add_docker_group() {
  local u="${SUDO_USER:-$(id -un)}"
  [ "$u" = root ] && return
  if id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    ok "User '$u' already in the docker group"
  else
    $SUDO usermod -aG docker "$u" && \
      ok "Added '$u' to the docker group — log out/in for non-sudo 'docker compose' (this run still uses sudo)"
  fi
}

install_nvidia_toolkit() {
  command -v nvidia-smi >/dev/null 2>&1 || die "nvidia-smi not found — install the NVIDIA driver first (e.g. 'ubuntu-drivers autoinstall' then reboot)."
  nvidia-smi -L || die "nvidia-smi failed — the GPU/driver is not healthy."
  if ! command -v nvidia-ctk >/dev/null 2>&1; then
    log "Installing NVIDIA Container Toolkit"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    $SUDO apt-get update -y
    $SUDO apt-get install -y nvidia-container-toolkit
  else
    ok "nvidia-container-toolkit already installed"
  fi
  # Idempotent: only (re)configure + restart Docker when the nvidia runtime isn't
  # already registered. Re-running this script to bring the stack up must NOT
  # bounce dockerd — that would kill running containers.
  if $SUDO docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
    ok "NVIDIA Docker runtime already configured"
  else
    log "Wiring the NVIDIA runtime into Docker"
    $SUDO nvidia-ctk runtime configure --runtime=docker
    $SUDO systemctl restart docker
  fi
}

verify_gpu() {
  log "Verifying GPU passthrough into containers"
  if $SUDO docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L; then
    ok "GPU is visible inside containers"
  else
    die "GPU NOT visible inside containers — re-check driver + nvidia-container-toolkit."
  fi
}

compose_files() {
  printf -- '-f docker-compose.yml'
  [ "$MODE" = everything ] && printf -- ' -f docker-compose.ai.yml'
}

bring_up() {
  if [ ! -f .env ]; then
    log "No .env found — creating one from the template"
    cp .env.deploy.example .env
    cat <<EOF

  Created .env from .env.deploy.example.
  EDIT IT before continuing (secrets!): set POSTGRES_PASSWORD, BETTER_AUTH_SECRET,
  BOT_INTERNAL_SECRET, HVISKE_API_KEY, DIARIZATION_API_KEY${MODE_HF}.
  Then re-run:  ./scripts/bootstrap-host.sh $([ "$MODE" = small ] && echo --small)
EOF
    exit 0
  fi
  log "Bringing up the stack ($MODE)"
  # shellcheck disable=SC2046
  $SUDO docker compose $(compose_files) up -d --build
  # shellcheck disable=SC2046
  $SUDO docker compose $(compose_files) ps
  ok "Stack is up. Health: docker compose $(compose_files) ps   |   App: curl http://localhost:\${APP_PORT:-8080}/api/health"
}

MODE_HF=""
[ "$MODE" = everything ] && MODE_HF=", and HF_TOKEN (for the diarization build)"

install_docker
if [ "$MODE" = everything ]; then
  install_nvidia_toolkit
  verify_gpu
else
  ok "Small mode — skipping GPU toolkit (no GPU services in this stack)"
fi

if [ "$DO_UP" -eq 1 ]; then
  bring_up
else
  ok "Install + verify complete (--no-up). Create .env then run without --no-up to start."
fi
