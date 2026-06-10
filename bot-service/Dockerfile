FROM mcr.microsoft.com/playwright:v1.56.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Install system deps for Chromium AND Xvfb so the bot can run headed
# inside a container. Teams' anti-bot heuristics detect headless mode and
# trigger post-admission "Leaving..." cascades; running Chromium with
# `headless: false` against an Xvfb virtual display sidesteps that
# detection. xdpyinfo is used by entrypoint.sh to wait for Xvfb readiness.
RUN npx playwright install-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11-utils \
    && rm -rf /var/lib/apt/lists/*
RUN npx playwright install chromium

# Microsoft Edge for Teams. Teams gates some code paths on the Edge UA +
# CDP fingerprint; running Chromium can produce post-admission "Leaving..."
# even with all the headed/Xvfb fixes. Skip on ARM64 (Edge for Linux is
# x86_64-only); the runtime falls back to Chromium when msedge isn't found.
RUN arch=$(uname -m) && if [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; then \
        npx playwright install msedge || true; \
    else \
        echo "Skipping msedge install on $arch (Edge for Linux is x86_64 only)"; \
    fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

RUN groupadd -r botuser && useradd -r -g botuser -d /app botuser \
    && chown -R botuser:botuser /app \
    && mkdir -p /home/botuser && chown botuser:botuser /home/botuser

ENV NODE_ENV=production
ENV DISPLAY=:99
ENV HEADLESS=false
USER botuser

EXPOSE 3001

CMD ["./entrypoint.sh"]
