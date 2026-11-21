import hashlib
import hmac
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse


SAFE_TOOLS = {
    "health_check",
    "inspect_tokenizer",
    "validate_json_schema",
    "list_models",
    "read_workspace_file",
    "create_document",
    "run_restricted_code",
    "retrieve_knowledge",
    "retrieve_memory",
    "local_workspace_ops",
}

LOCAL_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
SESSION_COOKIE_NAME = "genesis_session"
SESSION_TTL_SECONDS = 8 * 60 * 60


def sanitize_filename(filename: str) -> str:
    base = Path(filename).name
    return re.sub(r"[^a-zA-Z0-9._-]", "_", base)


def validate_attachment(
    filename: str,
    size_bytes: int,
    allowed_extensions: list[str],
    max_upload_mb: int,
) -> tuple[bool, str]:
    sanitized = sanitize_filename(filename)
    ext = Path(sanitized).suffix.lower()
    if not ext or ext not in [e.lower() for e in allowed_extensions]:
        return False, f"Extension '{ext or '(none)'}' is blocked by upload security policy."
    max_bytes = max_upload_mb * 1024 * 1024
    if size_bytes < 0 or size_bytes > max_bytes:
        return False, f"File exceeds maximum allowed size of {max_upload_mb} MB."
    return True, sanitized


def is_local_inference_url_safe(raw_url: str) -> tuple[bool, str]:
    try:
        parsed = urlparse(raw_url)
    except Exception:
        return False, "Invalid URL format."
    if parsed.scheme not in {"http", "https"}:
        return False, "Only http:// or https:// endpoints are allowed."
    if (parsed.hostname or "") not in LOCAL_LOOPBACK_HOSTS:
        return False, (
            f"Host '{parsed.hostname}' blocked by local-only policy. "
            "Only localhost / 127.0.0.1 endpoints are permitted."
        )
    return True, "Valid local loopback endpoint."


def hash_passcode(passcode: str, salt_hex: str | None = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    derived = hashlib.pbkdf2_hmac("sha256", passcode.encode("utf-8"), salt, 100_000)
    return derived.hex(), salt.hex()


def verify_passcode(passcode: str, stored_hash: str, stored_salt: str) -> bool:
    if not stored_hash or not stored_salt:
        return False
    candidate_hash, _ = hash_passcode(passcode, stored_salt)
    return hmac.compare_digest(candidate_hash, stored_hash)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(conn: sqlite3.Connection, ttl_seconds: int = SESSION_TTL_SECONDS) -> tuple[str, str]:
    token = secrets.token_hex(32)
    token_hash = hash_session_token(token)
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(seconds=ttl_seconds)).isoformat()
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now.isoformat(),))
    conn.execute(
        "INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)",
        (token_hash, expires_at, now.isoformat()),
    )
    conn.commit()
    return token, expires_at


def verify_session_token(conn: sqlite3.Connection, token: str | None) -> bool:
    if not token or not isinstance(token, str) or len(token) < 32:
        return False
    token_hash = hash_session_token(token)
    row = conn.execute("SELECT expires_at FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone()
    if not row:
        return False
    expires_at = datetime.fromisoformat(row["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        conn.commit()
        return False
    return True


def revoke_session_token(conn: sqlite3.Connection, token: str | None) -> None:
    if not token:
        return
    token_hash = hash_session_token(token)
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
    conn.commit()


def clear_all_sessions(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM sessions")
    conn.commit()


class PasscodeRateLimiter:
    """Thread-safe sliding-window rate limiter for failed passcode verification attempts."""

    def __init__(self, max_failures: int = 5, window_seconds: float = 60.0) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._attempts: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> list[float]:
        recent = [ts for ts in self._attempts.get(key, []) if (now - ts) < self.window_seconds]
        if recent:
            self._attempts[key] = recent
        else:
            self._attempts.pop(key, None)
        return recent

    def check(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        with self._lock:
            recent = self._prune(key, now)
            if len(recent) >= self.max_failures:
                retry_after = max(1, math.ceil(self.window_seconds - (now - recent[0])))
                return False, retry_after
            return True, 0

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            recent = self._prune(key, now)
            recent.append(now)
            self._attempts[key] = recent

    def clear(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)


passcode_rate_limiter = PasscodeRateLimiter()


class SandboxedToolRegistry:
    """Enforces allowlist-only tool execution under strict sandbox policy."""

    @staticmethod
    def list_allowed_tools() -> list[str]:
        return sorted(SAFE_TOOLS)

    @staticmethod
    def validate_execution(tool_name: str, allowed_tools: list[str]) -> tuple[bool, str]:
        if tool_name not in SAFE_TOOLS:
            return False, f"Tool '{tool_name}' is not in the global safety allowlist."
        if tool_name not in allowed_tools:
            return False, f"Tool '{tool_name}' is not enabled on this agent blueprint."
        return True, "Tool authorized for sandboxed execution."


SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("OpenAI-style API key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("Google/Gemini API key", re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b")),
    ("GitHub personal access token", re.compile(r"\bghp_[A-Za-z0-9]{20,}\b")),
    ("AWS access key ID", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "Credential assignment",
        re.compile(
            r"(?i)\b(?:password|passcode|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['\"]?[^\s'\"]{6,}"
        ),
    ),
]


def detect_sensitive_secret(text: str) -> str | None:
    """Return a descriptive label if text appears to contain raw credentials or API keys."""
    if not text:
        return None
    for label, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            return label
    return None

