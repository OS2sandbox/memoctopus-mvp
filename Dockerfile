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
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000
ENV PORT=3000
# Next.js standalone server.js binds to $HOSTNAME. Docker auto-sets HOSTNAME to
# the container id, which makes the server listen only on the container's IP —
# so an in-container `wget localhost:3000` healthcheck gets "connection refused".
# Pin the bind address to all interfaces so loopback (and the healthcheck) works.
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
