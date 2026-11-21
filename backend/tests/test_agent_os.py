import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.agent.agent_manager import AgentManager
from app.agent.result_reporter import AgentResultReporter
from app.agent.task_executor import TaskExecutionEngine
from app.agent.task_planner import AgentTaskPlanner
from app.agent.task_state_manager import TaskStateManager
from app.agent.tool_registry import AgentToolRegistry, AgentToolResult, AgentToolDefinition, AgentToolContext
from app.ai.memory_retrieval import chunk_knowledge_text


def _create_step07_schema(conn: sqlite3.Connection) -> None:
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
            parameter_count TEXT NOT NULL DEFAULT 'Pending Training',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
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
        CREATE TABLE agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            allowed_tools_json TEXT NOT NULL DEFAULT '[]',
            sandbox_policy_json TEXT NOT NULL DEFAULT '{}',
            system_prompt TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'ready',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE agent_tasks (
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
        CREATE TABLE agent_task_steps (
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
        CREATE TABLE agent_execution_history (
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


class TestStep07AgentOperatingSystem(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.workspace_dir = Path(self.tmp_dir.name) / "agent_workspace"
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        (self.workspace_dir / "notes.txt").write_text("Line 1\nLine 2\nGenesis Sandbox OK", encoding="utf-8")

        self.db_path = Path(self.tmp_dir.name) / "agent_step07.db"
        self.conn = sqlite3.connect(str(self.db_path), timeout=15.0)
        self.conn.row_factory = sqlite3.Row
        _create_step07_schema(self.conn)

        now = "2026-01-01T00:00:00+00:00"
        self.agent_id = "agent-task-operator"
        self.all_tools = [
            "retrieve_memory",
            "retrieve_knowledge",
            "read_workspace_file",
            "create_document",
            "run_restricted_code",
            "local_workspace_ops",
        ]
        self.conn.execute(
            """
            INSERT INTO agents (
                id, name, role, description, allowed_tools_json, sandbox_policy_json, system_prompt, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                self.agent_id,
                "Genesis Task Operator",
                "Local Orchestrator",
                "Step 07 Python test operator",
                json.dumps(self.all_tools),
                json.dumps({"allow_network": False, "allow_filesystem_write": True, "max_steps": 6}),
                "Be safe.",
                "ready",
                now,
                now,
            ),
        )
        # Approved memory + unapproved memory + KB doc
        self.conn.execute(
            """
            INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, created_at, updated_at)
            VALUES (?, 'project', 'constraint', ?, ?, ?, 5, 1, ?, ?)
            """,
            ("mem-1", "Workspace Budget", "Keep workspace evaluation lightweight for Windows.", '["budget"]', now, now),
        )
        self.conn.execute(
            """
            INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, created_at, updated_at)
            VALUES (?, 'project', 'fact', ?, ?, ?, 5, 0, ?, ?)
            """,
            ("mem-unapproved", "Secret Draft", "Should never be retrieved for workspace planning.", '["draft"]', now, now),
        )
        self.conn.execute(
            """
            INSERT INTO knowledge_documents (id, title, source_type, source_name, content, tags_json, chunk_count, created_at, updated_at)
            VALUES (?, ?, 'markdown', 'guide.md', ?, '["workspace"]', 1, ?, ?)
            """,
            ("doc-1", "Workspace Evaluation Guide", "Workspace evaluation should verify checksum and token budget.", now, now),
        )
        for idx, chunk in enumerate(chunk_knowledge_text("Workspace evaluation should verify checksum and token budget.")):
            self.conn.execute(
                "INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (f"chk-{idx}", "doc-1", idx, chunk["content"], 12, now),
            )
        self.conn.execute(
            "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
            ("mem-1", "Workspace Budget", "Keep workspace evaluation lightweight for Windows.", "budget"),
        )
        self.conn.execute(
            "INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)",
            ("chk-0", "doc-1", "Workspace Evaluation Guide", "Workspace evaluation should verify checksum and token budget.", "workspace"),
        )
        self.conn.commit()

        self.registry = AgentToolRegistry()
        self.planner = AgentTaskPlanner(self.registry)
        self.state_manager = TaskStateManager()
        self.reporter = AgentResultReporter()
        self.executor = TaskExecutionEngine(self.registry, self.state_manager, self.reporter)
        self.manager = AgentManager(self.registry, self.planner, self.state_manager, self.executor, self.reporter)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp_dir.cleanup()

    def test_tool_registry_sandbox_and_future_stubs(self) -> None:
        descriptors = {d["id"]: d for d in self.manager.list_tools()}
        self.assertTrue(descriptors["read_workspace_file"]["operational"])
        self.assertTrue(descriptors["create_document"]["requires_approval"])
        self.assertTrue(descriptors["run_restricted_code"]["requires_approval"])
        self.assertFalse(descriptors["web_search_future"]["operational"])
        self.assertEqual(descriptors["web_search_future"]["risk_level"], "reserved_stub")

        ctx = AgentToolContext(conn=self.conn, agent_id=self.agent_id, task_id="t-1", workspace_root=str(self.workspace_dir))

        # Allowed read inside workspace_dir
        ok_read = self.registry.invoke("read_workspace_file", {"path": "notes.txt"}, self.all_tools, ctx)
        self.assertTrue(ok_read.ok)
        self.assertEqual(ok_read.data["line_count"], 3)

        # Blocked path traversal, .db, .env, secret file
        self.assertFalse(self.registry.invoke("read_workspace_file", {"path": "../secret.txt"}, self.all_tools, ctx).ok)
        self.assertFalse(self.registry.invoke("read_workspace_file", {"path": "genesis.db"}, self.all_tools, ctx).ok)
        self.assertFalse(self.registry.invoke("read_workspace_file", {"path": ".env"}, self.all_tools, ctx).ok)

        # Restricted Python AST sandbox executes math/JSON cleanly and blocks import/open
        ok_code = self.registry.invoke(
            "run_restricted_code",
            {"code": "x = 7 * 6\nprint('eval', x)\nresult = {'answer': x}"},
            self.all_tools,
            ctx,
        )
        self.assertTrue(ok_code.ok)
        self.assertIn("42", ok_code.data["result"])
        self.assertFalse(self.registry.invoke("run_restricted_code", {"code": "import os\nos.listdir('.')"}, self.all_tools, ctx).ok)
        self.assertFalse(self.registry.invoke("run_restricted_code", {"code": "open('notes.txt').read()"}, self.all_tools, ctx).ok)

        # Future stub & allowlist enforcement
        self.assertFalse(self.registry.invoke("web_search_future", {"query": "hi"}, ["web_search_future"], ctx).ok)
        self.assertFalse(self.registry.invoke("read_workspace_file", {"path": "notes.txt"}, ["health_check"], ctx).ok)

    def test_sequential_execution_approval_gate_memory_save_and_rejection(self) -> None:
        ws = str(self.workspace_dir)
        detail = self.manager.create_and_plan_task(
            self.conn,
            agent_id=self.agent_id,
            title="Workspace Budget Audit",
            goal="Inspect workspace evaluation metrics, compute score, and write report",
            target_file_path="notes.txt",
            document_filename="audit_summary.md",
            code_snippet="score = round(100 * 0.95)\nresult = {'score': score}",
            auto_run=False,
            workspace_root=ws,
        )
        self.assertEqual(detail["task"]["status"], "planned")
        mem_ids = [m["id"] for m in detail["task"]["memory_context"]["memories"]]
        self.assertIn("mem-1", mem_ids)
        self.assertNotIn("mem-unapproved", mem_ids)

        # Run until approval pause on run_restricted_code
        paused_code = self.manager.run_task(self.conn, detail["task"]["id"], workspace_root=ws)
        if paused_code["task"]["status"] != "awaiting_approval":
            print("TASK FAIL ERROR:", paused_code["task"]["error_message"], [s["error_message"] for s in paused_code["steps"]])
        self.assertEqual(paused_code["task"]["status"], "awaiting_approval")
        code_step = next(s for s in paused_code["steps"] if s["tool_name"] == "run_restricted_code")
        self.assertEqual(code_step["status"], "awaiting_approval")

        # Approve code -> pauses on create_document
        paused_doc = self.manager.handle_step_approval(
            self.conn,
            task_id=detail["task"]["id"],
            step_id=code_step["id"],
            approved=True,
            note="Code safe",
            workspace_root=ws,
        )
        self.assertEqual(paused_doc["task"]["status"], "awaiting_approval")
        doc_step = next(s for s in paused_doc["steps"] if s["tool_name"] == "create_document")
        self.assertEqual(doc_step["status"], "awaiting_approval")

        # Approve document -> writes inside workspace_dir/documents & completes
        completed = self.manager.handle_step_approval(
            self.conn,
            task_id=detail["task"]["id"],
            step_id=doc_step["id"],
            approved=True,
            note="Write approved",
            workspace_root=ws,
        )
        self.assertEqual(completed["task"]["status"], "completed")
        self.assertTrue((self.workspace_dir / "documents" / "audit_summary.md").exists())
        self.assertEqual(completed["report"]["completed_steps"], completed["report"]["total_steps"])

        # Explicit user approval enforcement when saving task outcome to User Memory
        with self.assertRaises(ValueError):
            self.manager.save_task_result_to_memory(self.conn, task_id=detail["task"]["id"], approved=False)
        with self.assertRaises(ValueError):
            self.manager.save_task_result_to_memory(
                self.conn,
                task_id=detail["task"]["id"],
                approved=True,
                content="api_key=sk-proj-secret1234567890abcd",
            )
        saved = self.manager.save_task_result_to_memory(
            self.conn,
            task_id=detail["task"]["id"],
            approved=True,
            title="Python Agent Audit Outcome",
        )
        self.assertEqual(saved["title"], "Python Agent Audit Outcome")

        # Rejection halts task cleanly
        rej_task = self.manager.create_and_plan_task(
            self.conn,
            agent_id=self.agent_id,
            goal="Evaluate python math",
            code_snippet="result = 2 + 2",
            auto_run=True,
            workspace_root=ws,
        )
        self.assertEqual(rej_task["task"]["status"], "awaiting_approval")
        awaiting = next(s for s in rej_task["steps"] if s["status"] == "awaiting_approval")
        rejected = self.manager.handle_step_approval(
            self.conn,
            task_id=rej_task["task"]["id"],
            step_id=awaiting["id"],
            approved=False,
            note="Declined",
            workspace_root=ws,
        )
        self.assertEqual(rejected["task"]["status"], "failed")

    def test_safe_retry_and_execution_history(self) -> None:
        calls = {"count": 0}

        def flaky_exec(_inp, _ctx) -> AgentToolResult:
            calls["count"] += 1
            if calls["count"] == 1:
                return AgentToolResult(ok=False, summary="Busy", data={}, error="Temporary lock", retryable=True)
            return AgentToolResult(ok=True, summary="Succeeded after retry", data={"calls": calls["count"]})

        self.registry.register(
            AgentToolDefinition(
                id="py_retry_tool",
                name="Python Retry Test",
                category="local_app",
                description="Transient retry check",
                risk_level="read_only",
                requires_approval=False,
                safe_retryable=True,
                operational=True,
                input_schema={"type": "object", "properties": {}},
                execute=flaky_exec,
            )
        )
        self.conn.execute(
            "UPDATE agents SET allowed_tools_json = ? WHERE id = ?",
            (json.dumps(["py_retry_tool"]), self.agent_id),
        )
        self.conn.commit()

        created = self.state_manager.create_task(
            self.conn,
            agent_id=self.agent_id,
            title="Retry Verification",
            goal="Verify retryable step",
            plan_steps=[
                {
                    "step_index": 0,
                    "title": "Flaky Step",
                    "description": "Runs twice cleanly",
                    "tool_name": "py_retry_tool",
                    "tool_input": {},
                    "requires_approval": False,
                    "safe_retryable": True,
                }
            ],
            memory_context={"memories": [], "knowledge": []},
            max_retries=2,
        )
        done = self.manager.run_task(self.conn, created["task"]["id"], workspace_root=str(self.workspace_dir))
        self.assertEqual(done["task"]["status"], "completed")
        self.assertEqual(done["steps"][0]["attempts"], 2)
        event_types = {h["event_type"] for h in done["history"]}
        self.assertIn("step_retried", event_types)
        self.assertIn("tool_executed", event_types)
        self.assertIn("task_completed", event_types)
