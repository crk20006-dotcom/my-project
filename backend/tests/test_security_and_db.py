import importlib.util
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.ai.tokenizer import BaselineTokenizer
from app.core.security import (
    PasscodeRateLimiter,
    clear_all_sessions,
    create_session,
    hash_passcode,
    is_local_inference_url_safe,
    revoke_session_token,
    validate_attachment,
    verify_passcode,
    verify_session_token,
)

HAS_FASTAPI = (
    importlib.util.find_spec("fastapi") is not None
    and importlib.util.find_spec("pydantic_settings") is not None
)


class TestSecurityAndSessions(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp_dir.name) / "test_genesis.db"
        self.conn = sqlite3.connect(str(self.db_path), timeout=15.0)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL;")
        self.conn.execute("PRAGMA busy_timeout = 5000;")
        self.conn.execute(
            """
            CREATE TABLE sessions (
                token_hash TEXT PRIMARY KEY,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp_dir.cleanup()

    def test_loopback_policy_blocks_0000_and_remote_hosts(self) -> None:
        self.assertTrue(is_local_inference_url_safe("http://127.0.0.1:8080")[0])
        self.assertTrue(is_local_inference_url_safe("http://localhost:8080")[0])
        self.assertFalse(is_local_inference_url_safe("http://0.0.0.0:8080")[0])
        self.assertFalse(is_local_inference_url_safe("https://api.example.com")[0])

    def test_pbkdf2_passcode_hashing_and_verification(self) -> None:
        pw_hash, salt = hash_passcode("genesis-alpha-1")
        self.assertTrue(verify_passcode("genesis-alpha-1", pw_hash, salt))
        self.assertFalse(verify_passcode("wrong-passcode", pw_hash, salt))

    def test_session_lifecycle_expiry_and_revocation(self) -> None:
        token, _ = create_session(self.conn, ttl_seconds=300)
        self.assertTrue(verify_session_token(self.conn, token))
        self.assertFalse(verify_session_token(self.conn, "invalid-short"))

        revoke_session_token(self.conn, token)
        self.assertFalse(verify_session_token(self.conn, token))

        token2, _ = create_session(self.conn, ttl_seconds=300)
        past = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
        self.conn.execute("UPDATE sessions SET expires_at = ?", (past,))
        self.conn.commit()
        self.assertFalse(verify_session_token(self.conn, token2))

        token3, _ = create_session(self.conn, ttl_seconds=300)
        clear_all_sessions(self.conn)
        self.assertFalse(verify_session_token(self.conn, token3))

    def test_passcode_rate_limiter_blocks_after_five_failures(self) -> None:
        limiter = PasscodeRateLimiter(max_failures=5, window_seconds=60.0)
        for _ in range(5):
            allowed, _ = limiter.check("127.0.0.1")
            self.assertTrue(allowed)
            limiter.record_failure("127.0.0.1")

        allowed, retry_after = limiter.check("127.0.0.1")
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry_after, 1)

        limiter.clear("127.0.0.1")
        self.assertTrue(limiter.check("127.0.0.1")[0])

    def test_tokenizer_and_attachment_validation(self) -> None:
        tok = BaselineTokenizer()
        res = tok.inspect("Project Genesis Step 02.1")
        self.assertGreater(res["token_count"], 0)
        ok, sanitized = validate_attachment("../../spec.md", 2048, [".md", ".txt"], 5)
        self.assertTrue(ok)
        self.assertEqual(sanitized, "spec.md")
        blocked, _ = validate_attachment("payload.exe", 1024, [".md", ".txt"], 5)
        self.assertFalse(blocked)


@unittest.skipUnless(HAS_FASTAPI, "FastAPI/pydantic-settings not installed in this container")
class TestFastApiAuthAndRoutes(unittest.TestCase):
    def setUp(self) -> None:
        from fastapi.testclient import TestClient
        from app.core.config import get_settings
        from app.db.database import init_database
        from app.main import create_app

        self.tmp_dir = tempfile.TemporaryDirectory()
        self.prev_db = os.environ.get("GENESIS_DB_PATH")
        os.environ["GENESIS_DB_PATH"] = str(Path(self.tmp_dir.name) / "fastapi.test.db")
        get_settings.cache_clear()
        init_database()
        self.client = TestClient(create_app())

    def tearDown(self) -> None:
        from app.core.config import get_settings

        if self.prev_db is None:
            os.environ.pop("GENESIS_DB_PATH", None)
        else:
            os.environ["GENESIS_DB_PATH"] = self.prev_db
        get_settings.cache_clear()
        self.tmp_dir.cleanup()

    def test_auth_protection_and_passcode_flow(self) -> None:
        res = self.client.put(
            "/api/settings",
            json={"local_auth_enabled": True, "new_passcode": "secret-pass-42"},
        )
        self.assertEqual(res.status_code, 200)
        token = res.json()["session_token"]

        # Unauthenticated request using a clean client without cookies is rejected
        from fastapi.testclient import TestClient
        from app.main import create_app

        anon_client = TestClient(create_app())
        self.assertEqual(anon_client.get("/api/conversations").status_code, 401)
        self.assertEqual(anon_client.get("/api/settings/export-db").status_code, 401)
        self.assertEqual(anon_client.post("/api/settings/reset").status_code, 401)
        self.assertEqual(anon_client.get("/api/health").status_code, 200)

        # Authenticated Bearer works
        authed = anon_client.get("/api/conversations", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(authed.status_code, 200)

        # Changing auth without current_passcode is forbidden
        forbidden = anon_client.put(
            "/api/settings",
            headers={"Authorization": f"Bearer {token}"},
            json={"local_auth_enabled": False},
        )
        self.assertEqual(forbidden.status_code, 403)


class TestStep04IntelligenceEngine(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """
            CREATE TABLE models (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider TEXT NOT NULL,
                model_type TEXT NOT NULL,
                local_path TEXT NOT NULL DEFAULT '',
                endpoint_url TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'placeholder',
                loading_status TEXT NOT NULL DEFAULT 'unloaded',
                context_length INTEGER NOT NULL DEFAULT 8192,
                quantization TEXT NOT NULL DEFAULT 'Not Configured',
                parameter_count TEXT NOT NULL DEFAULT 'Pending',
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        self.conn.execute(
            "INSERT INTO models (id, name, provider, model_type, local_path, context_length) VALUES (?, ?, ?, ?, ?, ?)",
            ("genesis-core-placeholder", "GENESIS CORE Placeholder", "genesis_core", "Foundation", "./weights/v0.safetensors", 16384),
        )
        self.conn.execute(
            "INSERT INTO models (id, name, provider, model_type, endpoint_url, context_length) VALUES (?, ?, ?, ?, ?, ?)",
            ("local-inference-http", "Local HTTP Server", "local_http", "HTTP", "http://127.0.0.1:8080", 8192),
        )
        self.conn.execute(
            "INSERT INTO models (id, name, provider, model_type, local_path, context_length) VALUES (?, ?, ?, ?, ?, ?)",
            ("gguf-manifest", "Local GGUF", "gguf_local", "GGUF", "./weights/local.gguf", 4096),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def test_context_packing_trims_oldest_messages(self) -> None:
        from app.ai.registry import build_context_messages

        history = [
            {"role": "user", "content": "OLD_ONE " + ("word " * 180)},
            {"role": "assistant", "content": "OLD_TWO " + ("word " * 180)},
            {"role": "user", "content": "LATEST_PROMPT"},
        ]
        packed, est_tokens, truncated = build_context_messages(history, context_length=512, max_output_tokens=128)
        self.assertGreaterEqual(truncated, 1)
        self.assertGreater(est_tokens, 0)
        self.assertEqual(packed[-1]["content"], "LATEST_PROMPT")
        self.assertFalse(any("OLD_ONE" in m["content"] for m in packed))

    async def test_adapter_resolution_and_demo_streaming(self) -> None:
        from app.ai.genesis_core_adapter import GenesisCorePlaceholderAdapter
        from app.ai.interfaces import InferenceRequest
        from app.ai.local_inference_adapter import LocalHttpInferenceAdapter, LocalWeightsManifestAdapter
        from app.ai.registry import resolve_model_adapter

        adapter_core, _ = resolve_model_adapter(self.conn, "genesis-core-placeholder", "http://127.0.0.1:8080")
        self.assertIsInstance(adapter_core, GenesisCorePlaceholderAdapter)
        chunks = [c async for c in adapter_core.generate_stream(InferenceRequest(messages=[{"role": "user", "content": "Hi"}]))]
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].type, "done")
        self.assertEqual(chunks[0].mode, "demo")
        self.assertEqual(chunks[0].finish_reason, "not_connected")

        adapter_http, _ = resolve_model_adapter(self.conn, "local-inference-http", "http://127.0.0.1:8080")
        self.assertIsInstance(adapter_http, LocalHttpInferenceAdapter)
        self.assertTrue(adapter_http.get_capabilities().supports_streaming)

        adapter_manifest, _ = resolve_model_adapter(self.conn, "gguf-manifest", "http://127.0.0.1:8080")
        self.assertIsInstance(adapter_manifest, LocalWeightsManifestAdapter)
        ok_load, _ = await adapter_manifest.load_weights("./weights/local.gguf")
        self.assertFalse(ok_load)

        with self.assertRaises(LookupError):
            resolve_model_adapter(self.conn, "missing-model-id", "http://127.0.0.1:8080")

