# Memoctopus Backend

FastAPI backend that provides:
- OpenAI API passthrough endpoints (Chat Completions, Audio Transcriptions)
- Prompt library CRUD API with user authentication
- Better-auth session management

## Setup

### Prerequisites

- Python 3.11 or higher
- [uv](https://github.com/astral-sh/uv) package manager
- [dbmate](https://github.com/amacneil/dbmate) for database migrations
- PostgreSQL database

### Installation

1. Install dependencies using uv:
```bash
cd backend
uv sync
```

2. Install dbmate (if not already installed):
```bash
# macOS
brew install dbmate

# Linux
sudo curl -fsSL -o /usr/local/bin/dbmate https://github.com/amacneil/dbmate/releases/latest/download/dbmate-linux-amd64
sudo chmod +x /usr/local/bin/dbmate
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Configure environment variables in `.env`:
```bash
# OpenAI API key for transcription and chat completions
OPENAI_API_KEY=your_actual_api_key_here

# PostgreSQL database connection string
DATABASE_URL=postgres://user:password@host:port/database?sslmode=disable
```

### Database Setup

Run database migrations using dbmate:

```bash
# Apply all pending migrations
dbmate up

# Check migration status
dbmate status

# Rollback last migration (if needed)
dbmate down
```

The migrations will create the following tables:
- **better-auth tables**: `user`, `session`, `account`, `verification`
- **prompts table**: Stores user prompts with categories
- **user_prompt_favorites**: Junction table for per-user favorite prompts

### Running the Server

Start the FastAPI server using uvicorn:

```bash
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The server will be available at `http://localhost:8000`

API documentation is available at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## API Endpoints

### Authentication

Most API endpoints require authentication using a session token from better-auth. Include the session token in requests using the `X-Session-Token` header:

```bash
curl http://localhost:8000/api/prompts \
  -H "X-Session-Token: your_session_token_here"
```

### Prompt Library API

#### GET /api/prompts

Get all prompts for the authenticated user.

**Example Request:**
```bash
curl http://localhost:8000/api/prompts \
  -H "X-Session-Token: your_session_token"
```

**Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Meeting Summary",
    "creator": {
      "id": "user123",
      "name": "John Doe"
    },
    "category": "Detaljeret referat",
    "isFavorite": true,
    "text": "Create a detailed summary of the meeting...",
    "createdAt": "2025-11-10T14:35:00Z",
    "updatedAt": "2025-11-10T14:35:00Z"
  }
]
```

#### POST /api/prompts

Create a new prompt.

**Example Request:**
```bash
curl http://localhost:8000/api/prompts \
  -H "X-Session-Token: your_session_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Quick Notes",
    "category": "Kort referat",
    "isFavorite": false,
    "text": "Summarize the key points..."
  }'
```

#### PUT /api/prompts/{prompt_id}

Update an existing prompt.

**Example Request:**
```bash
curl -X PUT http://localhost:8000/api/prompts/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-Session-Token: your_session_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Name",
    "category": "Beslutningsreferat",
    "isFavorite": true,
    "text": "Updated prompt text..."
  }'
```

#### DELETE /api/prompts/{prompt_id}

Delete a prompt.

**Example Request:**
```bash
curl -X DELETE http://localhost:8000/api/prompts/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-Session-Token: your_session_token"
```

**Available Categories:**
- `Beslutningsreferat` - Decision summary
- `API` - API documentation
- `To do liste` - To-do list
- `Detaljeret referat` - Detailed summary
- `Kort referat` - Brief summary

---

### OpenAI Passthrough Endpoints

#### POST /v1/chat/completions

Passthrough endpoint that forwards requests to OpenAI's Chat Completions API. Supports both regular JSON responses and Server-Sent Events (SSE) streaming.

**Example Request (Regular JSON Response):**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "developer",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1741570283,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?",
        "refusal": null
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 9,
    "total_tokens": 29
  }
}
```

**Example Request (Streaming Response):**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "stream": true,
    "messages": [
      {
        "role": "developer",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'
```

**Response (SSE Stream):**
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

### POST /v1/audio/transcriptions

Passthrough endpoint that forwards requests to OpenAI's Audio Transcriptions API. Supports both regular JSON responses and Server-Sent Events (SSE) streaming.

**Example Request (Regular JSON Response):**

```bash
curl http://localhost:8000/v1/audio/transcriptions \
  -H "Content-Type: multipart/form-data" \
  -F file="@/path/to/audio.mp3" \
  -F model="gpt-4o-transcribe"
```

**Response:**
```json
{
  "text": "Imagine the wildest idea that you've ever had, and you're curious about how it might scale to something that's a 100, a 1,000 times bigger. This is a place where you can get to do that.",
  "usage": {
    "type": "tokens",
    "input_tokens": 14,
    "input_token_details": {
      "text_tokens": 0,
      "audio_tokens": 14
    },
    "output_tokens": 45,
    "total_tokens": 59
  }
}
```

**Example Request (Streaming Response):**

```bash
curl http://localhost:8000/v1/audio/transcriptions \
  -H "Content-Type: multipart/form-data" \
  -F file="@/path/to/audio.mp3" \
  -F model="gpt-4o-mini-transcribe" \
  -F stream=true
```

**Response (SSE Stream):**
```
data: {"type":"transcript.text.delta","delta":"I","logprobs":[{"token":"I","logprob":-0.00007588794,"bytes":[73]}]}

data: {"type":"transcript.text.delta","delta":" see","logprobs":[{"token":" see","logprob":-3.1281633e-7,"bytes":[32,115,101,101]}]}

data: {"type":"transcript.text.delta","delta":" skies","logprobs":[{"token":" skies","logprob":-2.3392786e-6,"bytes":[32,115,107,105,101,115]}]}

data: {"type":"transcript.text.delta","delta":" of","logprobs":[{"token":" of","logprob":-3.1281633e-7,"bytes":[32,111,102]}]}

...

data: {"type":"transcript.text.done","text":"I see skies of blue and clouds of white, the bright blessed days, the dark sacred nights, and I think to myself, what a wonderful world.","logprobs":[...],"usage":{"input_tokens":14,"input_token_details":{"text_tokens":0,"audio_tokens":14},"output_tokens":45,"total_tokens":59}}
```

---

### GET /health

Health check endpoint.

**Example Request:**

```bash
curl http://localhost:8000/health
```

## Project Structure

```
backend/
├── main.py                   # FastAPI application entry point
├── auth.py                   # Authentication middleware (better-auth session validation)
├── database.py               # Database connection setup (asyncpg/databases)
├── models.py                 # Pydantic models for API validation
├── routers/
│   └── prompts.py           # Prompt library CRUD endpoints
├── db/
│   └── migrations/          # Database migrations (managed by dbmate)
│       ├── 20251110143000_create_better_auth_tables.sql
│       ├── 20251110143452_create_prompts_table.sql
│       └── 20251110145950_add_user_prompt_favorites.sql
├── pyproject.toml           # Project dependencies (managed by uv)
├── uv.lock                  # Dependency lock file
├── .env.example             # Environment variable template
├── .env                     # Your environment variables (not in git)
└── README.md               # This file
```

## Database Schema

### better-auth Tables
- **user**: User accounts (id, name, email, emailVerified, image, timestamps)
- **session**: User sessions (id, token, expiresAt, userId, ipAddress, userAgent)
- **account**: Authentication providers (id, accountId, providerId, userId, tokens, password)
- **verification**: Email verification tokens

### Application Tables
- **prompts**: User prompt templates (id, name, creator_id, creator_name, category, text, timestamps)
- **user_prompt_favorites**: Per-user favorite prompts junction table (user_id, prompt_id)

### Migrations
All migrations are managed using dbmate and stored in `db/migrations/`. Each migration includes both `migrate:up` and `migrate:down` sections for rollback support.
