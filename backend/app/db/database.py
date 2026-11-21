import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from app.core.config import get_settings


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_connection() -> sqlite3.Connection:
    settings = get_settings()
    db_path: Path = settings.resolved_db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def _seed_defaults(conn: sqlite3.Connection) -> None:
    settings = get_settings()
    now = utc_now()
    row = conn.execute("SELECT COUNT(*) AS c FROM system_settings").fetchone()
    if row["c"] == 0:
        default_settings = {
            "operator_name": "Local Operator",
            "local_auth_enabled": False,
            "passcode_hash": "",
            "passcode_salt": "",
            "inference_endpoint_url": settings.genesis_inference_url,
            "prefer_local_inference": False,
            "active_model_id": "genesis-core-placeholder",
            "chat_use_memory": True,
            "chat_use_knowledge": True,
            "inference_temperature": 0.2,
            "inference_max_tokens": 512,
            "inference_timeout_ms": 30000,
            "max_upload_mb": settings.genesis_max_upload_mb,
            "allowed_extensions": settings.allowed_extension_list,
            "sandbox_strict_mode": True,
            "voice_sample_rate": 16000,
            "voice_vad_threshold": 0.45,
            "voice_stt_adapter": "placeholder_whisper_local",
            "voice_tts_adapter": "placeholder_piper_local",
        }
        conn.execute(
            "INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
            ("core_config", json.dumps(default_settings), now),
        )

    models_row = conn.execute("SELECT COUNT(*) AS c FROM models").fetchone()
    if models_row["c"] == 0:
        conn.execute(
            """
            INSERT INTO models (
                id, name, provider, model_type, local_path, endpoint_url, status, loading_status,
                context_length, quantization, parameter_count, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "genesis-core-placeholder",
                "GENESIS CORE (Placeholder Adapter)",
                "genesis_core",
                "Foundation Transformer (Future In-House Weights)",
                "./weights/genesis-core-v0.safetensors",
                "",
                "placeholder",
                "unloaded",
                16384,
                "FP16 / BF16 Target",
                "Pending Pre-training",
                json.dumps({"architecture": "GenesisDecoderArchitecture", "weights_verified": False}),
                now,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO models (
                id, name, provider, model_type, local_path, endpoint_url, status, loading_status,
                context_length, quantization, parameter_count, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "local-inference-http",
                "Local Inference Server Adapter",
                "local_http",
                "OpenAI-Compatible Local HTTP Endpoint",
                "",
                settings.genesis_inference_url,
                "unreachable",
                "unloaded",
                8192,
                "GGUF / Local Server Managed",
                "External Local Process",
                json.dumps({"architecture": "LocalHttpInferenceAdapter", "weights_verified": False}),
                now,
                now,
            ),
        )

    agents_row = conn.execute("SELECT COUNT(*) AS c FROM agents").fetchone()
    if agents_row["c"] == 0:
        conn.execute(
            """
            INSERT OR IGNORE INTO agents (
                id, name, role, description, allowed_tools_json, sandbox_policy_json, system_prompt, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "agent-workspace-auditor",
                "Workspace Diagnostics Agent",
                "System & Configuration Inspector",
                "Inspects local database health, validates JSON schemas, and enumerates registered model manifests under strict read-only sandbox constraints.",
                json.dumps(["health_check", "inspect_tokenizer", "validate_json_schema", "list_models"]),
                json.dumps(
                    {
                        "allow_network": False,
                        "allow_filesystem_write": False,
                        "allow_shell_execution": False,
                        "max_steps": 4,
                        "workspace_scope": "./data/agent_workspace",
                    }
                ),
                "Operate strictly within read-only workspace tools. Never request external network access or arbitrary shell execution.",
                "ready",
                now,
                now,
            ),
        )
    has_operator = conn.execute("SELECT 1 FROM agents WHERE id = 'agent-task-operator'").fetchone()
    has_tasks = conn.execute("SELECT COUNT(*) AS c FROM agent_tasks").fetchone()["c"] > 0
    if not has_operator and (agents_row["c"] == 0 or not has_tasks):
        conn.execute(
            """
            INSERT OR IGNORE INTO agents (
                id, name, role, description, allowed_tools_json, sandbox_policy_json, system_prompt, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "agent-task-operator",
                "Genesis Task Operator",
                "Local Memory, File & Document Orchestrator",
                "Breaks goals into sequential plans using approved Memory, Knowledge Base retrieval, safe workspace file processing, approval-gated document creation, and restricted expression evaluation.",
                json.dumps(
                    [
                        "retrieve_memory",
                        "retrieve_knowledge",
                        "read_workspace_file",
                        "create_document",
                        "run_restricted_code",
                        "local_workspace_ops",
                    ]
                ),
                json.dumps(
                    {
                        "allow_network": False,
                        "allow_filesystem_write": True,
                        "allow_shell_execution": False,
                        "max_steps": 6,
                        "workspace_scope": "./data/agent_workspace",
                    }
                ),
                "Plan carefully, check User Memory and Knowledge Base first, and request explicit operator approval before writing documents or executing restricted code.",
                "ready",
                now,
                now,
            ),
        )

    workspace_dir = Path.cwd() / "data" / "agent_workspace"
    docs_dir = workspace_dir / "documents"
    docs_dir.mkdir(parents=True, exist_ok=True)
    readme_file = workspace_dir / "workspace_readme.txt"
    if not readme_file.exists():
        readme_file.write_text(
            "\n".join(
                [
                    "Project Genesis — Approved Agent Workspace",
                    "Scope: ./data/agent_workspace",
                    "Policy: Read/write operations are strictly confined to approved local workspace folders.",
                    "External network egress and arbitrary shell commands remain disabled.",
                ]
            ),
            encoding="utf-8",
        )


def init_database() -> None:
    conn = get_connection()
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                module TEXT NOT NULL DEFAULT 'chat',
                model_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                attachments_json TEXT NOT NULL DEFAULT '[]',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                importance INTEGER NOT NULL DEFAULT 3,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS research_projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                tags_json TEXT NOT NULL DEFAULT '[]',
                sources_json TEXT NOT NULL DEFAULT '[]',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS models (
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
                parameter_count TEXT NOT NULL DEFAULT 'Pending Training',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                description TEXT NOT NULL,
                allowed_tools_json TEXT NOT NULL DEFAULT '[]',
                sandbox_policy_json TEXT NOT NULL DEFAULT '{}',
                system_prompt TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'ready',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS laboratory_items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                schema_json TEXT NOT NULL DEFAULT '{}',
                metrics_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS creator_artifacts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                artifact_type TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'markdown',
                content TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS knowledge_documents (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT 'note',
                source_name TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                char_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                token_estimate INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_tasks (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                title TEXT NOT NULL,
                goal TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'planned',
                plan_json TEXT NOT NULL DEFAULT '[]',
                current_step_index INTEGER NOT NULL DEFAULT 0,
                memory_context_json TEXT NOT NULL DEFAULT '{}',
                result_summary TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                max_retries INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_task_steps (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL,
                tool_input_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'pending',
                requires_approval INTEGER NOT NULL DEFAULT 0,
                approval_status TEXT NOT NULL DEFAULT 'not_required',
                approval_note TEXT NOT NULL DEFAULT '',
                safe_retryable INTEGER NOT NULL DEFAULT 1,
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 2,
                output_json TEXT NOT NULL DEFAULT '{}',
                error_message TEXT NOT NULL DEFAULT '',
                started_at TEXT,
                completed_at TEXT,
                FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_execution_history (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                step_id TEXT,
                agent_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                tool_name TEXT NOT NULL DEFAULT '',
                detail TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
                ON messages (conversation_id, created_at);

            CREATE INDEX IF NOT EXISTS idx_memory_namespace
                ON memory_entries (namespace);

            CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc
                ON knowledge_chunks (document_id, chunk_index);

            CREATE INDEX IF NOT EXISTS idx_agent_tasks_status
                ON agent_tasks (status, updated_at);

            CREATE INDEX IF NOT EXISTS idx_agent_task_steps_task
                ON agent_task_steps (task_id, step_index);

            CREATE INDEX IF NOT EXISTS idx_agent_history_task
                ON agent_execution_history (task_id, created_at);
            """
        )

        # Idempotent Step 06 migrations on memory_entries
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(memory_entries)").fetchall()}
        if "category" not in cols:
            conn.execute("ALTER TABLE memory_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'fact'")
        if "approved" not in cols:
            conn.execute("ALTER TABLE memory_entries ADD COLUMN approved INTEGER NOT NULL DEFAULT 1")
        if "source_conversation_id" not in cols:
            conn.execute("ALTER TABLE memory_entries ADD COLUMN source_conversation_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_approved ON memory_entries (approved, category)")

        try:
            conn.executescript(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
                    memory_id UNINDEXED,
                    title,
                    content,
                    tags
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    document_id UNINDEXED,
                    title,
                    content,
                    tags
                );
                """
            )
        except sqlite3.OperationalError:
            pass

        _seed_defaults(conn)
        sync_fts_indexes(conn)
        conn.commit()
    finally:
        conn.close()


def has_fts5_support(conn: sqlite3.Connection) -> bool:
    try:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts'"
        ).fetchone()
        return bool(row)
    except sqlite3.Error:
        return False


def sync_fts_indexes(conn: sqlite3.Connection) -> None:
    if not has_fts5_support(conn):
        return
    fts_mem = conn.execute("SELECT COUNT(*) AS c FROM memory_entries_fts").fetchone()["c"]
    raw_mem = conn.execute("SELECT COUNT(*) AS c FROM memory_entries").fetchone()["c"]
    if fts_mem != raw_mem:
        conn.execute("DELETE FROM memory_entries_fts")
        for r in conn.execute("SELECT id, title, content, tags_json FROM memory_entries").fetchall():
            try:
                tags_text = " ".join(json.loads(r["tags_json"] or "[]"))
            except Exception:
                tags_text = ""
            conn.execute(
                "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
                (r["id"], r["title"], r["content"], tags_text),
            )

    fts_chk = conn.execute("SELECT COUNT(*) AS c FROM knowledge_chunks_fts").fetchone()["c"]
    raw_chk = conn.execute("SELECT COUNT(*) AS c FROM knowledge_chunks").fetchone()["c"]
    if fts_chk != raw_chk:
        conn.execute("DELETE FROM knowledge_chunks_fts")
        rows = conn.execute(
            """
            SELECT c.id AS chunk_id, c.document_id, d.title, c.content, d.tags_json
            FROM knowledge_chunks c
            JOIN knowledge_documents d ON d.id = c.document_id
            """
        ).fetchall()
        for r in rows:
            try:
                tags_text = " ".join(json.loads(r["tags_json"] or "[]"))
            except Exception:
                tags_text = ""
            conn.execute(
                "INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)",
                (r["chunk_id"], r["document_id"], r["title"], r["content"], tags_text),
            )


def get_core_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    settings = get_settings()
    defaults: dict[str, Any] = {
        "operator_name": "Local Operator",
        "local_auth_enabled": False,
        "passcode_hash": "",
        "passcode_salt": "",
        "inference_endpoint_url": settings.genesis_inference_url,
        "prefer_local_inference": False,
        "active_model_id": "genesis-core-placeholder",
        "chat_use_memory": True,
        "chat_use_knowledge": True,
        "inference_temperature": 0.2,
        "inference_max_tokens": 512,
        "inference_timeout_ms": 30000,
        "max_upload_mb": settings.genesis_max_upload_mb,
        "allowed_extensions": settings.allowed_extension_list,
        "sandbox_strict_mode": True,
        "voice_sample_rate": 16000,
        "voice_vad_threshold": 0.45,
        "voice_stt_adapter": "placeholder_whisper_local",
        "voice_tts_adapter": "placeholder_piper_local",
    }
    row = conn.execute("SELECT value_json FROM system_settings WHERE key = 'core_config'").fetchone()
    if not row:
        return defaults
    return {**defaults, **json.loads(row["value_json"])}


def reset_workspace_data(conn: sqlite3.Connection) -> None:
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM agent_execution_history")
        conn.execute("DELETE FROM agent_task_steps")
        conn.execute("DELETE FROM agent_tasks")
        conn.execute("DELETE FROM messages")
        conn.execute("DELETE FROM conversations")
        conn.execute("DELETE FROM memory_entries")
        conn.execute("DELETE FROM knowledge_chunks")
        conn.execute("DELETE FROM knowledge_documents")
        conn.execute("DELETE FROM research_projects")
        conn.execute("DELETE FROM models")
        conn.execute("DELETE FROM agents")
        conn.execute("DELETE FROM laboratory_items")
        conn.execute("DELETE FROM creator_artifacts")
        if has_fts5_support(conn):
            conn.execute("DELETE FROM memory_entries_fts")
            conn.execute("DELETE FROM knowledge_chunks_fts")
        _seed_defaults(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
