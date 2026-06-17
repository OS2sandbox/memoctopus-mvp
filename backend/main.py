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

# Local transcription service (NVIDIA Parakeet)
TRANSCRIPTION_BASE_URL = os.getenv("TRANSCRIPTION_BASE_URL", "http://localhost:8003")
TRANSCRIPTION_URL = f"{TRANSCRIPTION_BASE_URL}/v1/audio/transcriptions"


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

    # Support optional API key for vLLM (#65)
    vllm_api_key = os.getenv("VLLM_API_KEY", "").strip()
    if vllm_api_key:
        headers["Authorization"] = f"Bearer {vllm_api_key}"

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
            try:
                response = await client.post(
                    VLLM_CHAT_URL,
                    json=body,
                    headers=headers,
                    timeout=120.0
                )
            except httpx.ConnectError:
                return JSONResponse(
                    content={"error": "Could not connect to LLM service."},
                    status_code=502
                )
            except httpx.ReadTimeout:
                return JSONResponse(
                    content={"error": "LLM service timed out."},
                    status_code=504
                )

            # Safely parse response
            try:
                content = response.json()
            except Exception:
                print(f"LLM service returned non-JSON: {response.text[:500]}")
                return JSONResponse(
                    content={"error": "LLM service returned an invalid response."},
                    status_code=502
                )
            return JSONResponse(content=content, status_code=response.status_code)


@app.post("/v1/audio/transcriptions")
async def audio_transcriptions(
    file: UploadFile = File(...),
    model: str = Form(...),
    stream: Optional[str] = Form(None)
):
    """
    Passthrough endpoint for local transcription service (NVIDIA Parakeet).
    Forwards the audio file to the transcription container and returns the result.
    """
    file_content = await file.read()

    files = {
        "file": (file.filename, file_content, file.content_type)
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                TRANSCRIPTION_URL,
                files=files,
                timeout=1800.0  # 30 min for large files (#60)
            )
        except httpx.ReadTimeout:
            return JSONResponse(
                content={"error": "Transcription service timed out. The audio file may be too large."},
                status_code=504
            )
        except httpx.ConnectError:
            return JSONResponse(
                content={"error": "Could not connect to transcription service."},
                status_code=502
            )

        # Safely parse response — transcription service may return non-JSON on error (#61)
        if response.status_code != 200:
            try:
                error_body = response.json()
            except Exception:
                error_body = {"error": f"Transcription service error (HTTP {response.status_code})", "raw": response.text[:500]}
            print(f"Transcription service error: {response.status_code} — {response.text[:500]}")
            return JSONResponse(content=error_body, status_code=response.status_code)

        try:
            content = response.json()
        except Exception:
            print(f"Transcription service returned non-JSON response: {response.text[:500]}")
            return JSONResponse(
                content={"error": "Transcription service returned an invalid response."},
                status_code=502
            )

        # Validate transcription is not empty (#62)
        transcription_text = content.get("text", "").strip() if isinstance(content, dict) else ""
        if not transcription_text:
            return JSONResponse(
                content={"error": "Transcription returned empty output. The audio may be silent, corrupted, or in an unsupported format."},
                status_code=422
            )

        return JSONResponse(content=content, status_code=200)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}
