"""
Tests for Issue #62: Transcription returns empty output instead of an error.

Verifies that the backend rejects empty transcription responses
instead of returning HTTP 200 with empty text.
"""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from httpx import Response


@pytest.mark.asyncio
async def test_empty_transcription_returns_422(app_client):
    """#62: Empty transcription text should return 422, not 200."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 200
    mock_response.text = '{"text": ""}'
    mock_response.json.return_value = {"text": ""}

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance):
        response = await app_client.post(
            "/v1/audio/transcriptions",
            files={"file": ("test.wav", b"fake audio content", "audio/wav")},
            data={"model": "whisper-1"},
        )

    assert response.status_code == 422
    data = response.json()
    assert "error" in data
    assert "empty" in data["error"].lower()


@pytest.mark.asyncio
async def test_whitespace_only_transcription_returns_422(app_client):
    """#62: Whitespace-only transcription should also be treated as empty."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 200
    mock_response.text = '{"text": "   "}'
    mock_response.json.return_value = {"text": "   "}

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance):
        response = await app_client.post(
            "/v1/audio/transcriptions",
            files={"file": ("test.wav", b"fake audio content", "audio/wav")},
            data={"model": "whisper-1"},
        )

    assert response.status_code == 422
    data = response.json()
    assert "error" in data


@pytest.mark.asyncio
async def test_valid_transcription_returns_200(app_client):
    """#62: Valid transcription with text should return 200."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 200
    mock_response.text = '{"text": "Hej verden"}'
    mock_response.json.return_value = {"text": "Hej verden"}

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance):
        response = await app_client.post(
            "/v1/audio/transcriptions",
            files={"file": ("test.wav", b"fake audio content", "audio/wav")},
            data={"model": "whisper-1"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "Hej verden"
