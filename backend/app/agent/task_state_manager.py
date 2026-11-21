import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_json(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback


class TaskStateManager:
    def create_task(
        self,
        conn: sqlite3.Connection,
        *,
        agent_id: str,
        title: str,
        goal: str,
        plan_steps: list[dict[str, Any]],
        memory_context: dict[str, Any],
        max_retries: int = 1,
    ) -> dict[str, Any]:
        task_id = f"task-{uuid.uuid4()}"
        now = _utc_now()
        retries = min(3, max(0, max_retries))

        conn.execute(
            """
            INSERT INTO agent_tasks (
                id, agent_id, title, goal, status, plan_json, current_step_index,
                memory_context_json, result_summary, error_message, max_retries, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                agent_id,
                title,
                goal,
                "planned",
                json.dumps(plan_steps),
                0,
                json.dumps(memory_context),
                "",
                "",
                retries,
                now,
                now,
                None,
            ),
        )

        for step in plan_steps:
            step_id = f"step-{uuid.uuid4()}"
            req_approval = bool(step.get("requires_approval", False))
            approval_status = "pending" if req_approval else "not_required"
            safe_retry = bool(step.get("safe_retryable", True))
            max_attempts = retries + 1 if safe_retry else 1
            conn.execute(
                """
                INSERT INTO agent_task_steps (
                    id, task_id, step_index, title, description, tool_name, tool_input_json,
                    status, requires_approval, approval_status, approval_note, safe_retryable,
                    attempts, max_attempts, output_json, error_message, started_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    step_id,
                    task_id,
                    int(step["step_index"]),
                    str(step["title"]),
                    str(step.get("description", "")),
                    str(step["tool_name"]),
                    json.dumps(step.get("tool_input") or {}),
                    "pending",
                    1 if req_approval else 0,
                    approval_status,
                    "",
                    1 if safe_retry else 0,
                    0,
                    max_attempts,
                    "{}",
                    "",
                    None,
                    None,
                ),
            )

        self.record_history(
            conn,
            task_id=task_id,
            agent_id=agent_id,
            event_type="task_created",
            detail=f"Task '{title}' planned with {len(plan_steps)} step(s).",
            payload={"step_count": len(plan_steps)},
        )
        conn.commit()
        return {"task": self.get_task(conn, task_id), "steps": self.list_steps(conn, task_id)}

    def get_task(self, conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
        row = conn.execute(
            """
            SELECT t.*, a.name AS agent_name
            FROM agent_tasks t
            LEFT JOIN agents a ON a.id = t.agent_id
            WHERE t.id = ?
            """,
            (task_id,),
        ).fetchone()
        return self._map_task(row) if row else None

    def list_tasks(self, conn: sqlite3.Connection, status: str | None = None) -> list[dict[str, Any]]:
        if status and status != "all":
            rows = conn.execute(
                """
                SELECT t.*, a.name AS agent_name
                FROM agent_tasks t
                LEFT JOIN agents a ON a.id = t.agent_id
                WHERE t.status = ?
                ORDER BY t.updated_at DESC
                """,
                (status,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT t.*, a.name AS agent_name
                FROM agent_tasks t
                LEFT JOIN agents a ON a.id = t.agent_id
                ORDER BY t.updated_at DESC
                """
            ).fetchall()
        return [self._map_task(r) for r in rows]

    def list_steps(self, conn: sqlite3.Connection, task_id: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT * FROM agent_task_steps WHERE task_id = ? ORDER BY step_index ASC",
            (task_id,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "task_id": r["task_id"],
                "step_index": r["step_index"],
                "title": r["title"],
                "description": r["description"],
                "tool_name": r["tool_name"],
                "tool_input": _parse_json(r["tool_input_json"], {}),
                "status": r["status"],
                "requires_approval": bool(r["requires_approval"]),
                "approval_status": r["approval_status"],
                "approval_note": r["approval_note"],
                "safe_retryable": bool(r["safe_retryable"]),
                "attempts": r["attempts"],
                "max_attempts": r["max_attempts"],
                "output": _parse_json(r["output_json"], {}),
                "error_message": r["error_message"],
                "started_at": r["started_at"],
                "completed_at": r["completed_at"],
            }
            for r in rows
        ]

    def update_task_state(self, conn: sqlite3.Connection, task_id: str, **patch: Any) -> None:
        current = self.get_task(conn, task_id)
        if not current:
            return
        conn.execute(
            """
            UPDATE agent_tasks
            SET status = ?, current_step_index = ?, result_summary = ?, error_message = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
            """,
            (
                patch.get("status", current["status"]),
                patch.get("current_step_index", current["current_step_index"]),
                patch.get("result_summary", current["result_summary"]),
                patch.get("error_message", current["error_message"]),
                _utc_now(),
                patch["completed_at"] if "completed_at" in patch else current["completed_at"],
                task_id,
            ),
        )
        conn.commit()

    def update_step_state(self, conn: sqlite3.Connection, step_id: str, **patch: Any) -> None:
        row = conn.execute("SELECT * FROM agent_task_steps WHERE id = ?", (step_id,)).fetchone()
        if not row:
            return
        conn.execute(
            """
            UPDATE agent_task_steps
            SET status = ?, approval_status = ?, approval_note = ?, attempts = ?, output_json = ?,
                error_message = ?, started_at = ?, completed_at = ?
            WHERE id = ?
            """,
            (
                patch.get("status", row["status"]),
                patch.get("approval_status", row["approval_status"]),
                patch.get("approval_note", row["approval_note"]),
                patch.get("attempts", row["attempts"]),
                json.dumps(patch["output"]) if "output" in patch else row["output_json"],
                patch.get("error_message", row["error_message"]),
                patch["started_at"] if "started_at" in patch else row["started_at"],
                patch["completed_at"] if "completed_at" in patch else row["completed_at"],
                step_id,
            ),
        )
        conn.commit()

    def record_history(
        self,
        conn: sqlite3.Connection,
        *,
        task_id: str,
        agent_id: str,
        event_type: str,
        detail: str,
        step_id: str | None = None,
        tool_name: str = "",
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        hist_id = f"ahist-{uuid.uuid4()}"
        now = _utc_now()
        payload_obj = payload or {}
        conn.execute(
            """
            INSERT INTO agent_execution_history (id, task_id, step_id, agent_id, event_type, tool_name, detail, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (hist_id, task_id, step_id, agent_id, event_type, tool_name, detail, json.dumps(payload_obj), now),
        )
        conn.commit()
        return {
            "id": hist_id,
            "task_id": task_id,
            "step_id": step_id,
            "agent_id": agent_id,
            "event_type": event_type,
            "tool_name": tool_name,
            "detail": detail,
            "payload": payload_obj,
            "created_at": now,
        }

    def list_history(
        self, conn: sqlite3.Connection, *, task_id: str | None = None, limit: int = 80
    ) -> list[dict[str, Any]]:
        capped = min(200, max(1, limit))
        if task_id:
            rows = conn.execute(
                "SELECT * FROM agent_execution_history WHERE task_id = ? ORDER BY created_at ASC LIMIT ?",
                (task_id, capped),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM agent_execution_history ORDER BY created_at DESC LIMIT ?",
                (capped,),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "task_id": r["task_id"],
                "step_id": r["step_id"],
                "agent_id": r["agent_id"],
                "event_type": r["event_type"],
                "tool_name": r["tool_name"],
                "detail": r["detail"],
                "payload": _parse_json(r["payload_json"], {}),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def delete_task(self, conn: sqlite3.Connection, task_id: str) -> bool:
        cur = conn.execute("DELETE FROM agent_tasks WHERE id = ?", (task_id,))
        conn.commit()
        return cur.rowcount > 0

    @staticmethod
    def _map_task(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "agent_id": row["agent_id"],
            "agent_name": row["agent_name"],
            "title": row["title"],
            "goal": row["goal"],
            "status": row["status"],
            "plan": _parse_json(row["plan_json"], []),
            "current_step_index": row["current_step_index"],
            "memory_context": _parse_json(row["memory_context_json"], {"memories": [], "knowledge": []}),
            "result_summary": row["result_summary"],
            "error_message": row["error_message"],
            "max_retries": row["max_retries"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "completed_at": row["completed_at"],
        }


default_task_state_manager = TaskStateManager()
