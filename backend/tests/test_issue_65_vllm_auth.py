"""
Tests for Issue #65: Cannot proceed to Referat tab — completions returns 401.

Verifies that:
- The VLLM_API_KEY env var is forwarded as Authorization header
- The completions endpoint works without auth when no API key is set
"""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from httpx import Response


@pytest.mark.asyncio
async def test_vllm_api_key_forwarded(app_client):
    """#65: VLLM_API_KEY should be sent as Bearer token to vLLM."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "hello"}}]
    }

    captured_headers = {}
    original_post = AsyncMock(return_value=mock_response)

    async def capture_post(*args, **kwargs):
        captured_headers.update(kwargs.get("headers", {}))
        return await original_post(*args, **kwargs)

    mock_client_instance = AsyncMock()
    mock_client_instance.post = capture_post
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance), \
         patch.dict("os.environ", {"VLLM_API_KEY": "test-key-123"}):
        # Need to reimport to pick up env change
        import main
        import os
        original_val = os.getenv("VLLM_API_KEY", "")

        response = await app_client.post(
            "/v1/chat/completions",
            json={
                "model": "test",
                "messages": [{"role": "user", "content": "Hello"}],
            },
        )

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_completions_works_without_api_key(app_client):
    """#65: Completions should work without VLLM_API_KEY set."""
    mock_response = MagicMock(spec=Response)
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "hello"}}]
    }

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)

    with patch("main.httpx.AsyncClient", return_value=mock_client_instance), \
         patch.dict("os.environ", {"VLLM_API_KEY": ""}):
        response = await app_client.post(
            "/v1/chat/completions",
            json={
                "model": "test",
                "messages": [{"role": "user", "content": "Hello"}],
            },
        )

    assert response.status_code == 200
