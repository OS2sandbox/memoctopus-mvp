FROM mcr.microsoft.com/playwright:v1.56.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Install system deps before browser to avoid missing libs
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN groupadd -r botuser && useradd -r -g botuser -d /app botuser \
    && chown -R botuser:botuser /app \
    && mkdir -p /home/botuser && chown botuser:botuser /home/botuser

ENV NODE_ENV=production
USER botuser

EXPOSE 3001

CMD ["node", "dist/index.js"]
