# Memoctopus

En open source platform til lydtransskription og referatgenerering.

## Funktioner

- **Lydtransskription** - Upload lydfiler og få dem automatisk transskriberet via OpenAI Whisper
- **Referatgenerering** - Generer strukturerede referater fra transskriptioner ved hjælp af LLM
- **Brugerdefinerbare prompts** - Opret og administrer egne prompt-skabeloner til forskellige mødetyper
- **Historik** - Gem og gennemse tidligere transskriptioner og referater
- **Eksport** - Eksporter referater i forskellige formater

## Hurtig start

```bash
# Klon repository
git clone https://github.com/OS2sandbox/memoctopus-mvp.git
cd memoctopus-mvp

# Skift til docker-compose branch
git checkout feat/docker-compose-prod-ready

# Kopier og konfigurer miljøvariabler
cp .env.example .env
# Rediger .env med dine værdier

# Byg og start alle services
docker compose up -d --build
```

## Deployment

### Forudsætninger

- Docker og Docker Compose
- NVIDIA GPU med CUDA-understøttelse (til vLLM)
- OpenAI API-nøgle (til lydtransskription)

### Opsætning

1. Kopier `.env.example` til `.env` og udfyld værdierne:

```bash
cp .env.example .env
```

2. Konfigurer miljøvariabler i `.env`:

```env
# PostgreSQL
POSTGRES_USER=postgres
POSTGRES_PASSWORD=din_sikre_adgangskode
POSTGRES_DB=memoctopus

# vLLM (chat completions)
HF_TOKEN=din_huggingface_token
VLLM_MODEL=Qwen/Qwen3-0.6B

# OpenAI (lydtransskription)
OPENAI_API_KEY=din_openai_api_nøgle

# Frontend
BETTER_AUTH_SECRET=din_auth_secret
```

3. Start alle services:

```bash
docker compose up -d
```

Applikationen er nu tilgængelig på:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- vLLM API: http://localhost:8001

## Arkitektur

### Backend

Python FastAPI-applikation der håndterer:
- Proxy til vLLM for chat completions
- Proxy til OpenAI for lydtransskription
- Database-operationer via PostgreSQL
- Prompt-administration
- Historik og eksport

**Teknologier:** Python, FastAPI, PostgreSQL, httpx

### Frontend

Next.js React-applikation med:
- Lydoptagelse og upload
- Transskription og referatgenerering
- Prompt-administration
- Brugerautentificering via Better Auth

**Teknologier:** Next.js, React, TypeScript, Tailwind CSS

### Services

| Service | Port | Beskrivelse |
|---------|------|-------------|
| frontend | 3000 | Next.js webapplikation |
| backend | 8000 | FastAPI REST API |
| vllm | 8001 | vLLM OpenAI-kompatibel API |
| postgres | 5432 | PostgreSQL database |

## Udvikling

### Lokal udvikling uden Docker

**Backend:**
```bash
cd backend
uv sync
uv run uvicorn main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

## Licens

Open source - se LICENSE fil for detaljer.
