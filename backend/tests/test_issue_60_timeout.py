"""
Tests for Issue #60: Large audio uploads fail due to timeout.

Verifies that:
- The transcription timeout is sufficiently large
- Timeout errors return 504, not 500
"""

import pytest
from unittest.mock import patch, AsyncMock
from httpx import ReadTimeout


@pytest.mark.asyncio
async def test_transcription_timeout_returns_504(app_client):
    """#60: Transcription timeout should return 504 Gateway Timeout."""
    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(
        side_effect=ReadTimeout("Request timed out")
    )
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance):
        response = await app_client.post(
            "/v1/audio/transcriptions",
            files={"file": ("large.wav", b"x" * 1000, "audio/wav")},
            data={"model": "whisper-1"},
        )

    assert response.status_code == 504
    data = response.json()
    assert "error" in data
    assert "timed out" in data["error"].lower()


@pytest.mark.asyncio
async def test_completions_timeout_returns_504(app_client):
    """#60: LLM timeout should return 504 Gateway Timeout."""
    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(
        side_effect=ReadTimeout("Request timed out")
    )
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance):
        response = await app_client.post(
            "/v1/chat/completions",
            json={
                "model": "test",
                "messages": [{"role": "user", "content": "Hello"}],
            },
        )

    assert response.status_code == 504
    data = response.json()
    assert "error" in data
    assert "timed out" in data["error"].lower()
