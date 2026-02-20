import os
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, File, UploadFile, Form
from fastapi.responses import JSONResponse, StreamingResponse
import httpx
from dotenv import load_dotenv
from typing import Optional

from starlette.middleware.cors import CORSMiddleware

from database import connect_db, disconnect_db, get_database_instance
from routers import prompts, history, export
from auth import get_current_user, AuthenticatedUser

load_dotenv()

HISTORY_CLEANUP_INTERVAL_HOURS = 24
HISTORY_RETENTION_DAYS = 7


async def cleanup_old_history_entries():
    """Delete history entries older than 7 days."""
    db = get_database_instance()
    query = """
        DELETE FROM history_entries
        WHERE created_at < NOW() - INTERVAL '7 days'
    """
    result = await db.execute(query)
    print(f"History cleanup: deleted old entries")


async def history_cleanup_task():
    """Background task that periodically cleans up old history entries."""
    while True:
        try:
            await cleanup_old_history_entries()
        except Exception as e:
            print(f"History cleanup error: {e}")
        await asyncio.sleep(HISTORY_CLEANUP_INTERVAL_HOURS * 60 * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    await connect_db()
    cleanup_task = asyncio.create_task(history_cleanup_task())
    yield
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    await disconnect_db()


app = FastAPI(lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Include routers
app.include_router(prompts.router)
app.include_router(history.router)
app.include_router(export.router)

# vLLM for chat completions
VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://localhost:8001/v1")
VLLM_MODEL = os.getenv("VLLM_MODEL", "Qwen/Qwen3-0.6B")
VLLM_CHAT_URL = f"{VLLM_BASE_URL}/chat/completions"

# OpenAI for audio transcription only
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_TRANSCRIPTION_URL = f"{OPENAI_BASE_URL}/audio/transcriptions"


async def stream_openai_response(client: httpx.AsyncClient, url: str, body: dict, headers: dict):
    """
    Stream SSE chunks from OpenAI response.
    """
    async with client.stream(
        "POST",
        url,
        json=body,
        headers=headers,
        timeout=60.0
    ) as response:
        async for chunk in response.aiter_bytes():
            yield chunk


async def stream_openai_multipart_response(client: httpx.AsyncClient, url: str, files: dict, data: dict, headers: dict):
    """
    Stream SSE chunks from OpenAI multipart response.
    """
    async with client.stream(
        "POST",
        url,
        files=files,
        data=data,
        headers=headers,
        timeout=120.0
    ) as response:
        async for chunk in response.aiter_bytes():
            yield chunk


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """
    Passthrough endpoint for vLLM chat completions API.
    Supports both regular JSON responses and SSE streaming.
    Forwards the request body directly to vLLM without validation.
    """
    body = await request.json()

    # Override model with configured vLLM model
    body["model"] = VLLM_MODEL

    headers = {
        "Content-Type": "application/json",
    }

    # Check if streaming is requested
    is_streaming = body.get("stream", False)

    if is_streaming:
        # Return streaming response with SSE content type
        client = httpx.AsyncClient()
        return StreamingResponse(
            stream_openai_response(client, VLLM_CHAT_URL, body, headers),
            media_type="text/event-stream"
        )
    else:
        # Return regular JSON response
        async with httpx.AsyncClient() as client:
            response = await client.post(
                VLLM_CHAT_URL,
                json=body,
                headers=headers,
                timeout=60.0
            )
            return JSONResponse(
                content=response.json(),
                status_code=response.status_code
            )


@app.post("/v1/audio/transcriptions")
async def audio_transcriptions(
    file: UploadFile = File(...),
    model: str = Form(...),
    stream: Optional[str] = Form(None)
):
    """
    Passthrough endpoint for OpenAI audio transcriptions API.
    Supports both regular JSON responses and SSE streaming.
    Forwards the request directly to OpenAI without validation.
    """
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}"
    }

    # Read the file content
    file_content = await file.read()

    # Prepare multipart form data
    files = {
        "file": (file.filename, file_content, file.content_type)
    }

    data = {
        "model": model
    }

    # Check if streaming is requested (stream can be "true" as string from form data)
    is_streaming = stream and stream.lower() == "true"

    if is_streaming:
        data["stream"] = "true"

    if is_streaming:
        # Return streaming response with SSE content type
        client = httpx.AsyncClient()
        return StreamingResponse(
            stream_openai_multipart_response(client, OPENAI_TRANSCRIPTION_URL, files, data, headers),
            media_type="text/event-stream"
        )
    else:
        # Return regular JSON response
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OPENAI_TRANSCRIPTION_URL,
                files=files,
                data=data,
                headers=headers,
                timeout=120.0
            )
            return JSONResponse(
                content=response.json(),
                status_code=response.status_code
            )


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}
