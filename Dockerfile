FROM node:22-alpine AS deps
WORKDIR /app
# .npmrc carries legacy-peer-deps=true — required for `npm ci` to resolve the
# better-call/zod peer conflict. Without it the install fails with ERESOLVE.
COPY package*.json .npmrc ./
# --ignore-scripts: the `postinstall` (scripts/copy-vad-assets.js) isn't present
# in this stage (only package files are copied). It's run in the builder stage
# below, once the full source tree is available.
RUN npm ci --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Stage the @ricky0123/vad-web assets into public/ (the postinstall hook skipped
# in deps) before building so Next.js bundles them.
RUN node scripts/copy-vad-assets.js
# NEXT_PUBLIC_* are inlined into the browser bundle at build time, so they must be
# present as build args — setting them only as runtime env (compose `environment`)
# does NOT change the client bundle. Compose passes these via the app `build.args`.
# Auth configuration deliberately does NOT appear here: the sign-in page resolves
# providers server-side per request (src/lib/auth/providers.ts), so operators can
# change login methods with a restart instead of an image rebuild.
ARG NEXT_PUBLIC_APP_URL=http://localhost:8080
ARG NEXT_PUBLIC_DIARIZATION_TIMEOUT_MS=300000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_DIARIZATION_TIMEOUT_MS=$NEXT_PUBLIC_DIARIZATION_TIMEOUT_MS
RUN npm run build

# Lightweight stage for the one-shot `migrate` compose service: it only needs
# drizzle-kit (in node_modules), the config, and the committed SQL migrations —
# NOT a full `npm run build`. Keeping it separate means applying a schema
# migration doesn't depend on (or pay for) a successful Next.js production build.
FROM node:22-alpine AS migrate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json drizzle.config.ts ./
COPY drizzle ./drizzle
CMD ["npx", "drizzle-kit", "migrate"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

RUN chown -R appuser:appgroup /app

# Bot recordings are stashed under AUDIO_STORAGE_PATH (mounted as the
# `audio-storage` volume at /audio-storage). Create it owned by appuser so a
# freshly-initialised named volume inherits that ownership — otherwise the
# non-root app can't mkdir/write there and bot audio uploads fail with EACCES.
RUN mkdir -p /audio-storage && chown -R appuser:appgroup /audio-storage
USER appuser

EXPOSE 3000
ENV PORT=3000
# Next.js standalone server.js binds to $HOSTNAME. Docker auto-sets HOSTNAME to
# the container id, which makes the server listen only on the container's IP —
# so an in-container `wget localhost:3000` healthcheck gets "connection refused".
# Pin the bind address to all interfaces so loopback (and the healthcheck) works.
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
