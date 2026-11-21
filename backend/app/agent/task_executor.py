import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from app.agent.result_reporter import AgentResultReporter, default_result_reporter
from app.agent.task_state_manager import TaskStateManager, default_task_state_manager
from app.agent.tool_registry import AgentToolContext, AgentToolRegistry, default_tool_registry


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TaskExecutionEngine:
    def __init__(
        self,
        registry: AgentToolRegistry = default_tool_registry,
        state_manager: TaskStateManager = default_task_state_manager,
        reporter: AgentResultReporter = default_result_reporter,
    ) -> None:
        self.registry = registry
        self.state_manager = state_manager
        self.reporter = reporter

    def execute_task(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        *,
        workspace_root: str | None = None,
    ) -> dict[str, Any]:
        task = self.state_manager.get_task(conn, task_id)
        if not task:
            raise ValueError("Agent task not found.")
        if task["status"] in {"cancelled", "completed"}:
            steps = self.state_manager.list_steps(conn, task_id)
            return {"task": task, "steps": steps, "report": self.reporter.build_report(task, steps)}

        agent = conn.execute("SELECT * FROM agents WHERE id = ?", (task["agent_id"],)).fetchone()
        if not agent:
            raise ValueError("Assigned agent blueprint not found.")
        try:
            allowed_tools = json.loads(agent["allowed_tools_json"] or "[]")
        except Exception:
            allowed_tools = []

        steps = self.state_manager.list_steps(conn, task_id)
        if not steps:
            now = _utc_now()
            self.state_manager.update_task_state(
                conn,
                task_id,
                status="completed",
                result_summary="Task had zero planned steps.",
                completed_at=now,
            )
            updated = self.state_manager.get_task(conn, task_id)
            return {"task": updated, "steps": steps, "report": self.reporter.build_report(updated, steps)}  # type: ignore[arg-type]

        self.state_manager.update_task_state(conn, task_id, status="running", error_message="")

        for step in steps:
            if step["status"] in {"completed", "skipped"}:
                continue
            if step["status"] == "rejected" or step["approval_status"] == "rejected":
                self.state_manager.update_task_state(
                    conn,
                    task_id,
                    status="failed",
                    current_step_index=step["step_index"],
                    error_message=f"Step '{step['title']}' was rejected by the operator.",
                    result_summary=f"Execution halted: operator rejected '{step['title']}'.",
                )
                steps = self.state_manager.list_steps(conn, task_id)
                failed_task = self.state_manager.get_task(conn, task_id)
                return {
                    "task": failed_task,
                    "steps": steps,
                    "report": self.reporter.build_report(failed_task, steps),  # type: ignore[arg-type]
                }

            tool_def = self.registry.get(step["tool_name"])
            needs_approval = bool(step["requires_approval"]) or bool(tool_def and tool_def.requires_approval)
            if needs_approval and step["approval_status"] != "approved":
                self.state_manager.update_step_state(
                    conn,
                    step["id"],
                    status="awaiting_approval",
                    approval_status="pending",
                )
                self.state_manager.update_task_state(
                    conn,
                    task_id,
                    status="awaiting_approval",
                    current_step_index=step["step_index"],
                    result_summary=(
                        f"Awaiting explicit operator approval for step {step['step_index'] + 1}: "
                        f"{step['title']} ({step['tool_name']})."
                    ),
                )
                self.state_manager.record_history(
                    conn,
                    task_id=task_id,
                    step_id=step["id"],
                    agent_id=task["agent_id"],
                    event_type="approval_requested",
                    tool_name=step["tool_name"],
                    detail=f"Approval required before running '{step['tool_name']}' on step '{step['title']}'.",
                    payload={"step_index": step["step_index"], "tool_input": step["tool_input"]},
                )
                steps = self.state_manager.list_steps(conn, task_id)
                paused_task = self.state_manager.get_task(conn, task_id)
                return {
                    "task": paused_task,
                    "steps": steps,
                    "report": self.reporter.build_report(paused_task, steps),  # type: ignore[arg-type]
                }

            self.state_manager.update_task_state(
                conn, task_id, status="running", current_step_index=step["step_index"]
            )
            self.state_manager.update_step_state(
                conn, step["id"], status="running", started_at=step.get("started_at") or _utc_now()
            )
            self.state_manager.record_history(
                conn,
                task_id=task_id,
                step_id=step["id"],
                agent_id=task["agent_id"],
                event_type="step_started",
                tool_name=step["tool_name"],
                detail=f"Executing step {step['step_index'] + 1}: {step['title']}.",
            )

            attempt = int(step.get("attempts", 0))
            max_attempts = max(1, int(step.get("max_attempts", 1)))
            final_res = None
            while attempt < max_attempts:
                attempt += 1
                res = self.registry.invoke(
                    step["tool_name"],
                    step["tool_input"],
                    allowed_tools,
                    AgentToolContext(
                        conn=conn,
                        agent_id=task["agent_id"],
                        task_id=task_id,
                        workspace_root=workspace_root,
                    ),
                )
                final_res = res
                if res.ok:
                    break
                if step.get("safe_retryable") and res.retryable and attempt < max_attempts:
                    self.state_manager.record_history(
                        conn,
                        task_id=task_id,
                        step_id=step["id"],
                        agent_id=task["agent_id"],
                        event_type="step_retried",
                        tool_name=step["tool_name"],
                        detail=f"Retrying safe step '{step['title']}' (attempt {attempt + 1}/{max_attempts}): {res.error or res.summary}",
                    )
                    continue
                break

            done_at = _utc_now()
            if final_res and final_res.ok:
                self.state_manager.update_step_state(
                    conn,
                    step["id"],
                    status="completed",
                    attempts=attempt,
                    output={"summary": final_res.summary, "data": final_res.data},
                    error_message="",
                    completed_at=done_at,
                )
                self.state_manager.record_history(
                    conn,
                    task_id=task_id,
                    step_id=step["id"],
                    agent_id=task["agent_id"],
                    event_type="tool_executed",
                    tool_name=step["tool_name"],
                    detail=final_res.summary,
                    payload={"attempts": attempt, "data": final_res.data},
                )
            else:
                err_msg = (final_res.error or final_res.summary) if final_res else "Unknown execution error."
                self.state_manager.update_step_state(
                    conn,
                    step["id"],
                    status="failed",
                    attempts=attempt,
                    output={"summary": final_res.summary, "data": final_res.data} if final_res else {},
                    error_message=err_msg,
                    completed_at=done_at,
                )
                self.state_manager.record_history(
                    conn,
                    task_id=task_id,
                    step_id=step["id"],
                    agent_id=task["agent_id"],
                    event_type="step_failed",
                    tool_name=step["tool_name"],
                    detail=err_msg,
                    payload={"attempts": attempt},
                )
                self.state_manager.update_task_state(
                    conn,
                    task_id,
                    status="failed",
                    current_step_index=step["step_index"],
                    error_message=err_msg,
                    result_summary=f"Failed at step {step['step_index'] + 1} ({step['title']}): {err_msg}",
                )
                self.state_manager.record_history(
                    conn,
                    task_id=task_id,
                    step_id=step["id"],
                    agent_id=task["agent_id"],
                    event_type="task_failed",
                    tool_name=step["tool_name"],
                    detail=f"Task failed at step {step['step_index'] + 1}: {err_msg}",
                )
                steps = self.state_manager.list_steps(conn, task_id)
                failed_task = self.state_manager.get_task(conn, task_id)
                return {
                    "task": failed_task,
                    "steps": steps,
                    "report": self.reporter.build_report(failed_task, steps),  # type: ignore[arg-type]
                }

        steps = self.state_manager.list_steps(conn, task_id)
        completed_at = _utc_now()
        provisional = self.reporter.build_report(
            {**task, "status": "completed", "completed_at": completed_at, "result_summary": ""},
            steps,
        )
        self.state_manager.update_task_state(
            conn,
            task_id,
            status="completed",
            current_step_index=max(0, len(steps) - 1),
            result_summary=provisional["summary"],
            error_message="",
            completed_at=completed_at,
        )
        self.state_manager.record_history(
            conn,
            task_id=task_id,
            agent_id=task["agent_id"],
            event_type="task_completed",
            detail=provisional["summary"],
            payload={
                "completed_steps": provisional["completed_steps"],
                "artifacts_created": provisional["artifacts_created"],
            },
        )
        completed_task = self.state_manager.get_task(conn, task_id)
        return {
            "task": completed_task,
            "steps": steps,
            "report": self.reporter.build_report(completed_task, steps),  # type: ignore[arg-type]
        }


default_task_executor = TaskExecutionEngine()
