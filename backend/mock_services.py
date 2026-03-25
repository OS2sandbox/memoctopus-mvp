"""
Mock AI services for local development without GPU.

Provides mock endpoints for:
- vLLM chat completions (/v1/chat/completions)
- Transcription service (/v1/audio/transcriptions)

Usage:
    uvicorn mock_services:app --port 8005
    Then set:
        VLLM_BASE_URL=http://localhost:8005/v1
        TRANSCRIPTION_BASE_URL=http://localhost:8005
"""

import time
import uuid
from fastapi import FastAPI, File, Form, UploadFile, Request
from fastapi.responses import JSONResponse
from typing import Optional

app = FastAPI(title="Mock AI Services")

MOCK_TRANSCRIPTION = (
    "**Speaker 1:** Velkommen til mødet. Lad os starte med at gennemgå dagsordenen.\n\n"
    "**Speaker 2:** Tak. Første punkt er status på projektet.\n\n"
    "**Speaker 1:** Vi er godt på vej. Backend er færdig, og frontend mangler kun et par rettelser.\n\n"
    "**Speaker 2:** Det lyder godt. Hvornår forventer vi at være færdige?\n\n"
    "**Speaker 1:** Vi sigter mod næste fredag."
)

MOCK_SUMMARY = (
    "## Mødereferat\n\n"
    "### Deltagere\n"
    "- Speaker 1 (Projektleder)\n"
    "- Speaker 2 (Teammedlem)\n\n"
    "### Beslutninger\n"
    "1. Projektet er på rette spor\n"
    "2. Backend er færdiggjort\n"
    "3. Frontend mangler mindre rettelser\n"
    "4. Deadline: næste fredag\n\n"
    "### Handlingspunkter\n"
    "- [ ] Færdiggør frontend-rettelser\n"
    "- [ ] Gennemfør test inden deadline\n"
)


@app.post("/v1/audio/transcriptions")
async def mock_transcription(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    stream: Optional[str] = Form(None),
    timestamps: Optional[str] = Form(None),
):
    """Mock transcription endpoint — returns a fixed Danish meeting transcript."""
    content = await file.read()
    if not content:
        return JSONResponse(
            content={"error": "Uploaded file is empty."},
            status_code=400,
        )

    result = {"text": MOCK_TRANSCRIPTION}

    if timestamps and timestamps.lower() == "true":
        result["word_timestamps"] = [
            {"word": "Velkommen", "start": 0.0, "end": 0.5},
            {"word": "til", "start": 0.5, "end": 0.7},
            {"word": "mødet", "start": 0.7, "end": 1.0},
        ]

    return JSONResponse(content=result)


@app.post("/v1/chat/completions")
async def mock_chat_completions(request: Request):
    """Mock vLLM chat completions — returns a fixed meeting summary."""
    body = await request.json()
    model = body.get("model", "mock-model")
    is_streaming = body.get("stream", False)

    if is_streaming:
        # For simplicity, return non-streaming response even if stream requested
        pass

    return JSONResponse(content={
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": MOCK_SUMMARY,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 150,
            "total_tokens": 250,
        },
    })


@app.get("/health")
async def health():
    return {"status": "healthy", "mode": "mock"}
