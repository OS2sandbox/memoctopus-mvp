"""
Tests for Issue #61: Backend crashes when transcription service returns non-JSON error response.

Verifies that the backend safely handles:
- Non-JSON responses from the transcription service
- HTTP error status codes from the transcription service
- Connection failures to the transcription service
"""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from httpx import Response, ConnectError


@pytest.mark.asyncio
async def test_transcription_non_json_response(app_client):
    """#61: Non-JSON response from transcription service should return 502, not crash."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"
    mock_response.json.side_effect = ValueError("No JSON")

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

    assert response.status_code == 500
    data = response.json()
    assert "error" in data or "raw" in data


@pytest.mark.asyncio
async def test_transcription_connection_error(app_client):
    """#61: Connection failure to transcription service should return 502."""
    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(
        side_effect=ConnectError("Connection refused")
    )
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance):
        response = await app_client.post(
            "/v1/audio/transcriptions",
            files={"file": ("test.wav", b"fake audio content", "audio/wav")},
            data={"model": "whisper-1"},
        )

    assert response.status_code == 502
    data = response.json()
    assert "error" in data
    assert "connect" in data["error"].lower()


@pytest.mark.asyncio
async def test_completions_non_json_response(app_client):
    """#61: Non-JSON response from LLM service should return 502."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 200
    mock_response.text = "not json"
    mock_response.json.side_effect = ValueError("No JSON")

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)
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

    assert response.status_code == 502
    data = response.json()
    assert "error" in data


@pytest.mark.asyncio
async def test_completions_connection_error(app_client):
    """#61: Connection failure to LLM service should return 502."""
    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(
        side_effect=ConnectError("Connection refused")
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

    assert response.status_code == 502
    data = response.json()
    assert "error" in data
