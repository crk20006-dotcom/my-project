import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.ai.memory_retrieval import (
    SqliteKeywordRetriever,
    chunk_knowledge_text,
    format_retrieved_system_context,
    has_fts5_support,
    search_conversation_history,
)
from app.ai.registry import build_context_messages
from app.core.security import detect_sensitive_secret


def _create_step06_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            module TEXT NOT NULL DEFAULT 'chat',
            model_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE memory_entries (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'semantic',
            category TEXT NOT NULL DEFAULT 'fact',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]',
            importance INTEGER NOT NULL DEFAULT 3,
            approved INTEGER NOT NULL DEFAULT 1,
            source_conversation_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE knowledge_documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'note',
            source_name TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]',
            chunk_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE knowledge_chunks (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            token_estimate INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
        );
        """
    )
    try:
        conn.executescript(
            """
            CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
                memory_id UNINDEXED,
                title,
                content,
                tags
            );
            CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                document_id UNINDEXED,
                title,
                content,
                tags
            );
            """
        )
    except sqlite3.Error:
        pass
    conn.commit()


class TestStep06MemoryAndKnowledge(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp_dir.name) / "memory_step06.db"
        self.conn = sqlite3.connect(str(self.db_path), timeout=15.0)
        self.conn.row_factory = sqlite3.Row
        _create_step06_schema(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp_dir.cleanup()

    def test_secret_detection_blocks_raw_keys_and_passwords(self) -> None:
        self.assertIsNotNone(detect_sensitive_secret("api_key=sk-proj-1234567890abcdef1234"))
        self.assertIsNotNone(detect_sensitive_secret("AIzaSyDUMMYKEYEXAMPLE1234567890ABCD"))
        self.assertIsNotNone(detect_sensitive_secret("password: MySuperSecretPassword9"))
        self.assertIsNotNone(detect_sensitive_secret("-----BEGIN PRIVATE KEY-----\nABC"))
        self.assertIsNone(detect_sensitive_secret("Prefer CPU-friendly transformer presets on Windows."))

    def test_chunking_fts_retrieval_and_restart_persistence(self) -> None:
        doc_text = (
            "Genesis Inference Engine connects locally to loopback servers on 127.0.0.1:8080.\n\n"
            + ("Modular Transformer weights are saved locally in checkpoints. " * 25)
        )
        chunks = chunk_knowledge_text(doc_text, chunk_size=300, overlap=50)
        self.assertGreaterEqual(len(chunks), 2)

        now = "2026-11-20T09:00:00+00:00"
        self.conn.execute(
            """
            INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "mem-1",
                "project",
                "constraint",
                "Target Workstation RAM",
                "Keep memory overhead safe for 16 GB Windows systems.",
                '["windows","ram"]',
                5,
                1,
                now,
                now,
            ),
        )
        self.conn.execute(
            """
            INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "mem-unapproved",
                "semantic",
                "fact",
                "Unapproved Secret",
                "Should never be retrieved for Windows systems because approved=0.",
                "[]",
                5,
                0,
                now,
                now,
            ),
        )
        self.conn.execute(
            """
            INSERT INTO knowledge_documents (id, title, source_type, source_name, content, tags_json, chunk_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("doc-1", "Inference Spec", "markdown", "spec.md", doc_text, '["inference"]', len(chunks), now, now),
        )
        for ch in chunks:
            cid = f"chk-{ch['chunk_index']}"
            self.conn.execute(
                "INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (cid, "doc-1", ch["chunk_index"], ch["content"], ch["token_estimate"], now),
            )

        if has_fts5_support(self.conn):
            self.conn.execute(
                "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
                ("mem-1", "Target Workstation RAM", "Keep memory overhead safe for 16 GB Windows systems.", "windows ram"),
            )
            self.conn.execute(
                "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
                ("mem-unapproved", "Unapproved Secret", "Should never be retrieved for Windows systems because approved=0.", ""),
            )
            for ch in chunks:
                self.conn.execute(
                    "INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)",
                    (f"chk-{ch['chunk_index']}", "doc-1", "Inference Spec", ch["content"], "inference"),
                )
        self.conn.commit()

        # Simulate process/app restart by closing and reopening DB handle from disk
        self.conn.close()
        self.conn = sqlite3.connect(str(self.db_path), timeout=15.0)
        self.conn.row_factory = sqlite3.Row

        retriever = SqliteKeywordRetriever(self.conn)
        result = retriever.retrieve("Windows RAM budget and loopback 8080")
        mem_ids = [m["id"] for m in result["memories"]]
        self.assertIn("mem-1", mem_ids)
        self.assertNotIn("mem-unapproved", mem_ids)
        self.assertTrue(any(k["document_id"] == "doc-1" for k in result["knowledge"]))

        sys_ctx = format_retrieved_system_context(result)
        self.assertIsNotNone(sys_ctx)
        packed, _, _ = build_context_messages(
            [{"role": "user", "content": "Windows RAM budget and loopback 8080"}],
            context_length=4096,
            max_output_tokens=512,
            system_prompt=sys_ctx,
        )
        self.assertEqual(packed[0]["role"], "system")
        self.assertIn("Target Workstation RAM", packed[0]["content"])

        # Unrelated query yields zero hits and does not invent context
        empty = retriever.retrieve("nonexistent_quantum_banana_term")
        self.assertEqual(empty["memories"], [])
        self.assertEqual(empty["knowledge"], [])
        self.assertIsNone(format_retrieved_system_context(empty))

    def test_conversation_history_search_stays_separated(self) -> None:
        now = "2026-11-20T09:05:00+00:00"
        self.conn.execute(
            "INSERT INTO conversations (id, title, module, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("conv-1", "Tokenizer Design", "chat", "genesis-core-placeholder", now, now),
        )
        self.conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            ("msg-1", "conv-1", "user", "Discuss ByteBPE merge table serialization.", now),
        )
        self.conn.commit()

        hits = search_conversation_history(self.conn, "ByteBPE")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["conversation_id"], "conv-1")
        # Conversation messages do not bleed into approved memory retrieval
        retriever = SqliteKeywordRetriever(self.conn)
        mem_result = retriever.retrieve("ByteBPE")
        self.assertEqual(mem_result["memories"], [])


if __name__ == "__main__":
    unittest.main()
