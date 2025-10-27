import os
from fastapi import FastAPI, Request, File, UploadFile, Form
from fastapi.responses import JSONResponse, StreamingResponse
import httpx
from dotenv import load_dotenv
from typing import Optional

load_dotenv()

app = FastAPI()

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")


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
    Passthrough endpoint for OpenAI chat completions API.
    Supports both regular JSON responses and SSE streaming.
    Forwards the request body directly to OpenAI without validation.
    """
    body = await request.json()

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}"
    }

    # Check if streaming is requested
    is_streaming = body.get("stream", False)

    if is_streaming:
        # Return streaming response with SSE content type
        client = httpx.AsyncClient()
        return StreamingResponse(
            stream_openai_response(client, OPENAI_CHAT_URL, body, headers),
            media_type="text/event-stream"
        )
    else:
        # Return regular JSON response
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OPENAI_CHAT_URL,
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
