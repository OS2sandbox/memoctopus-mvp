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
