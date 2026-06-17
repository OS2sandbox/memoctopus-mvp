"""
Test configuration for backend tests.

Mocks the database and external services so tests run without
PostgreSQL, vLLM, or transcription containers.
"""

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Ensure backend module is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before importing app modules
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("VLLM_BASE_URL", "http://localhost:8005/v1")
os.environ.setdefault("TRANSCRIPTION_BASE_URL", "http://localhost:8005")


@pytest.fixture()
def mock_db():
    """Mock the database module so no real DB connection is needed."""
    db = MagicMock()
    db.fetch_one = AsyncMock(return_value=None)
    db.fetch_all = AsyncMock(return_value=[])
    db.execute = AsyncMock(return_value=None)
    return db


@pytest.fixture()
def app_client(mock_db):
    """Create a test client for the FastAPI app with mocked dependencies."""
    from httpx import ASGITransport, AsyncClient

    # Patch database to avoid real connections
    with patch("database.database", mock_db), \
         patch("database.get_database", return_value=mock_db), \
         patch("database.get_database_instance", return_value=mock_db), \
         patch("main.connect_db", new_callable=AsyncMock), \
         patch("main.disconnect_db", new_callable=AsyncMock), \
         patch("main.history_cleanup_task", new_callable=AsyncMock):

        from main import app

        transport = ASGITransport(app=app)
        client = AsyncClient(transport=transport, base_url="http://test")
        yield client
