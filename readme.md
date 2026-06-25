# Referat

Next.js app for recording meetings, generating transcripts, and producing
summaries (referater). Uses hviske-ensemble for speech-to-text and OpenAI for
chapter, topic, minutes generation, and PII detection.

## Setup

1. `cp .env.example .env` and fill in the values.
2. `npm install`
3. `npm run db:migrate`
4. `npm run dev`

## Scripts

- `npm run dev` — start the Next.js dev server
- `npm run build` / `npm start` — production build and serve
- `npm test` — run the Vitest suite
- `npm run db:generate` / `db:migrate` / `db:studio` — Drizzle migrations
