from fastapi import HTTPException, Request, status
from app.core.security import SESSION_COOKIE_NAME, verify_session_token
from app.db.database import get_connection, get_core_settings


def extract_session_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        bearer = auth_header[7:].strip()
        if bearer:
            return bearer
    cookie_val = request.cookies.get(SESSION_COOKIE_NAME)
    return cookie_val or None


def require_authenticated_session(request: Request) -> None:
    conn = get_connection()
    try:
        settings = get_core_settings(conn)
        if not settings.get("local_auth_enabled") or not settings.get("passcode_hash"):
            return
        token = extract_session_token(request)
        if not verify_session_token(conn, token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required or session expired.",
            )
    finally:
        conn.close()
