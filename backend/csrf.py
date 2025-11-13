"""
CSRF Protection Middleware and Utilities

This module provides CSRF token generation, validation, and middleware
to protect against Cross-Site Request Forgery attacks.
"""

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
import secrets
from typing import Optional


def generate_csrf_token() -> str:
    """Generate a secure random CSRF token."""
    return secrets.token_urlsafe(32)


class CSRFMiddleware(BaseHTTPMiddleware):
    """
    Middleware to validate CSRF tokens on state-changing requests.

    Validates X-CSRF-Token header for POST, PUT, DELETE, PATCH requests.
    Excludes specific paths that don't require CSRF protection.
    """

    # Paths that don't require CSRF validation
    EXEMPT_PATHS = [
        "/health",
        "/docs",
        "/redoc",
        "/openapi.json",
        # OpenAI passthrough endpoints (validated via API key)
        "/v1/chat/completions",
        "/v1/audio/transcriptions",
        # Export endpoint (no auth required, just validation)
        "/api/export",
    ]

    # Methods that require CSRF validation
    PROTECTED_METHODS = ["POST", "PUT", "DELETE", "PATCH"]

    async def dispatch(self, request: Request, call_next):
        """
        Process the request and validate CSRF token if needed.

        Args:
            request: The incoming request
            call_next: The next middleware/handler

        Returns:
            Response: The response from the handler

        Raises:
            HTTPException: 403 if CSRF validation fails
        """
        # Skip validation for exempt paths
        if any(request.url.path.startswith(path) for path in self.EXEMPT_PATHS):
            return await call_next(request)

        # Skip validation for non-protected methods
        if request.method not in self.PROTECTED_METHODS:
            return await call_next(request)

        # Validate CSRF token
        csrf_token = request.headers.get("X-CSRF-Token")
        session_token = request.headers.get("X-Session-Token") or request.cookies.get("better_auth_session_token")

        if not csrf_token:
            raise HTTPException(
                status_code=403,
                detail="CSRF token missing"
            )

        if not session_token:
            # Let auth middleware handle this
            return await call_next(request)

        # Validate CSRF token against session
        from database import get_database_instance

        db = get_database_instance()
        if db is None:
            # Database not initialized yet, skip validation
            return await call_next(request)

        query = """
            SELECT csrf_token
            FROM session
            WHERE token = :session_token
            AND "expiresAt" > NOW()
        """

        result = await db.fetch_one(
            query=query,
            values={"session_token": session_token}
        )

        if not result:
            raise HTTPException(
                status_code=403,
                detail="Invalid session"
            )

        if result["csrf_token"] != csrf_token:
            raise HTTPException(
                status_code=403,
                detail="Invalid CSRF token"
            )

        return await call_next(request)


async def get_csrf_token(session_token: str) -> Optional[str]:
    """
    Get the CSRF token for a session.

    Args:
        session_token: The session token

    Returns:
        str: The CSRF token if session is valid, None otherwise
    """
    from database import get_database_instance

    db = get_database_instance()
    if db is None:
        return None

    query = """
        SELECT csrf_token
        FROM session
        WHERE token = :session_token
        AND "expiresAt" > NOW()
    """

    result = await db.fetch_one(
        query=query,
        values={"session_token": session_token}
    )

    return result["csrf_token"] if result else None


async def create_csrf_token_for_session(session_token: str) -> str:
    """
    Create or retrieve CSRF token for a session.

    If session doesn't have a CSRF token, generates and stores one.

    Args:
        session_token: The session token

    Returns:
        str: The CSRF token

    Raises:
        ValueError: If session is invalid
    """
    from database import get_database_instance

    db = get_database_instance()
    if db is None:
        raise ValueError("Database not initialized")

    # Check if session already has CSRF token
    existing_token = await get_csrf_token(session_token)
    if existing_token:
        return existing_token

    # Generate new CSRF token
    csrf_token = generate_csrf_token()

    # Update session with CSRF token
    query = """
        UPDATE session
        SET csrf_token = :csrf_token
        WHERE token = :session_token
        AND "expiresAt" > NOW()
        RETURNING csrf_token
    """

    result = await db.fetch_one(
        query=query,
        values={
            "csrf_token": csrf_token,
            "session_token": session_token
        }
    )

    if not result:
        raise ValueError("Invalid or expired session")

    return result["csrf_token"]
