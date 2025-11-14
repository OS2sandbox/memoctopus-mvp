from fastapi import HTTPException, Cookie, Depends, Header
from typing import Optional
from database import get_database, Database


class AuthenticatedUser:
    """Represents an authenticated user from the session."""

    def __init__(self, id: str, name: str, email: str):
        self.id = id
        self.name = name
        self.email = email


async def get_current_user(
    x_session_token: Optional[str] = Header(None),
    better_auth_session_token: Optional[str] = Cookie(None),
    db: Database = Depends(get_database)
) -> AuthenticatedUser:
    """
    Dependency that extracts and validates the current user from the session.

    Accepts session token from either X-Session-Token header or cookie.

    Args:
        x_session_token: Session token from X-Session-Token header (preferred for cross-origin)
        better_auth_session_token: Session token from better-auth cookie (fallback)
        db: Database instance

    Returns:
        AuthenticatedUser: The authenticated user

    Raises:
        HTTPException: If the user is not authenticated or session is invalid
    """
    # Prefer header token (for cross-origin requests), fallback to cookie
    session_token = x_session_token or better_auth_session_token

    if not session_token:
        raise HTTPException(
            status_code=401,
            detail="Not authenticated - no session token"
        )

    # Query the session table to get the user ID
    # Note: better-auth uses camelCase column names
    query = """
        SELECT s."userId", u.name, u.email
        FROM session s
        JOIN "user" u ON s."userId" = u.id
        WHERE s.token = :token
        AND s."expiresAt" > NOW()
    """

    result = await db.fetch_one(
        query=query,
        values={"token": session_token}
    )

    if not result:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired session"
        )

    return AuthenticatedUser(
        id=result["userId"],
        name=result["name"],
        email=result["email"]
    )


async def get_optional_user(
    x_session_token: Optional[str] = Header(None),
    better_auth_session_token: Optional[str] = Cookie(None),
    db: Database = Depends(get_database)
) -> Optional[AuthenticatedUser]:
    """
    Optional authentication dependency that returns None if not authenticated.
    Useful for endpoints that can work with or without authentication.
    """
    session_token = x_session_token or better_auth_session_token

    if not session_token:
        return None

    try:
        return await get_current_user(x_session_token, better_auth_session_token, db)
    except HTTPException:
        return None
