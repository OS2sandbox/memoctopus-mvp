FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY scripts/copy-vad-assets.js scripts/copy-vad-assets.js
RUN npm ci --legacy-peer-deps

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED=false
ARG NEXT_PUBLIC_MICROSOFT_ENABLED=true
ARG NEXT_PUBLIC_AUTHENTIK_ENABLED=false
ARG NEXT_PUBLIC_APP_URL=https://taletiltekst.syddjurs.dk

RUN npm run build

# Slim migration image: only drizzle-orm, pg and their transitive deps
FROM node:22-alpine AS migrate-deps
WORKDIR /deps
RUN npm init -y && npm install --legacy-peer-deps drizzle-orm pg 2>/dev/null

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=migrate-deps /deps/node_modules ./node_modules/

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
