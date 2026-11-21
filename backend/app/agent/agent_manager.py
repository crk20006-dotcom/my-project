import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from app.ai.memory_retrieval import has_fts5_support
from app.agent.result_reporter import AgentResultReporter, default_result_reporter
from app.agent.task_executor import TaskExecutionEngine, default_task_executor
from app.agent.task_planner import AgentTaskPlanner, default_task_planner
from app.agent.task_state_manager import TaskStateManager, default_task_state_manager
from app.agent.tool_registry import AgentToolRegistry, default_tool_registry
from app.core.security import detect_sensitive_secret


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentManager:
    def __init__(
        self,
        registry: AgentToolRegistry = default_tool_registry,
        planner: AgentTaskPlanner = default_task_planner,
        state_manager: TaskStateManager = default_task_state_manager,
        executor: TaskExecutionEngine = default_task_executor,
        reporter: AgentResultReporter = default_result_reporter,
    ) -> None:
        self.registry = registry
        self.planner = planner
        self.state_manager = state_manager
        self.executor = executor
        self.reporter = reporter

    def list_tools(self) -> list[dict[str, Any]]:
        return self.registry.list_descriptors()

    def get_allowed_operational_tool_ids(self) -> list[str]:
        return self.registry.get_operational_tool_ids()

    def create_and_plan_task(
        self,
        conn: sqlite3.Connection,
        *,
        agent_id: str,
        goal: str,
        title: str | None = None,
        target_file_path: str | None = None,
        document_filename: str | None = None,
        code_snippet: str | None = None,
        max_retries: int = 1,
        auto_run: bool = False,
        workspace_root: str | None = None,
    ) -> dict[str, Any]:
        cleaned_goal = goal.strip()
        if not cleaned_goal:
            raise ValueError("Task goal cannot be empty.")
        secret_hit = detect_sensitive_secret(f"{title or ''}\n{cleaned_goal}\n{code_snippet or ''}")
        if secret_hit:
            raise ValueError(f"Rejected for privacy: potential {secret_hit} detected in task specification.")

        agent = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not agent:
            raise ValueError("Agent blueprint not found.")
        allowed_tools = json.loads(agent["allowed_tools_json"] or "[]")
        policy = json.loads(agent["sandbox_policy_json"] or '{"max_steps": 6}')

        plan = self.planner.plan_task(
            conn,
            goal=cleaned_goal,
            allowed_tools=allowed_tools,
            max_steps=int(policy.get("max_steps", 6)),
            title=title,
            target_file_path=target_file_path,
            document_filename=document_filename,
            code_snippet=code_snippet,
        )
        created = self.state_manager.create_task(
            conn,
            agent_id=agent["id"],
            title=plan["title"],
            goal=cleaned_goal,
            plan_steps=plan["steps"],
            memory_context=plan["memory_context"],
            max_retries=max_retries,
        )
        task_id = created["task"]["id"]
        self.state_manager.record_history(
            conn,
            task_id=task_id,
            agent_id=agent["id"],
            event_type="plan_generated",
            detail=(
                f"Generated {len(plan['steps'])}-step plan ({plan['planner_mode']}). "
                f"Attached {len(plan['memory_context']['memories'])} memory & "
                f"{len(plan['memory_context']['knowledge'])} KB reference(s)."
            ),
        )
        if auto_run:
            self.executor.execute_task(conn, task_id, workspace_root=workspace_root)
        return self.get_task_detail(conn, task_id)  # type: ignore[return-value]

    def list_tasks(self, conn: sqlite3.Connection, status: str | None = None) -> list[dict[str, Any]]:
        tasks = self.state_manager.list_tasks(conn, status)
        enriched = []
        for t in tasks:
            steps = self.state_manager.list_steps(conn, t["id"])
            enriched.append(
                {
                    **t,
                    "step_count": len(steps),
                    "completed_steps": sum(1 for s in steps if s["status"] == "completed"),
                    "pending_approvals": sum(1 for s in steps if s["status"] == "awaiting_approval"),
                }
            )
        return enriched

    def get_task_detail(self, conn: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
        task = self.state_manager.get_task(conn, task_id)
        if not task:
            return None
        steps = self.state_manager.list_steps(conn, task_id)
        history = self.state_manager.list_history(conn, task_id=task_id, limit=150)
        return {
            "task": task,
            "steps": steps,
            "report": self.reporter.build_report(task, steps),
            "history": history,
        }

    def run_task(
        self, conn: sqlite3.Connection, task_id: str, *, workspace_root: str | None = None
    ) -> dict[str, Any]:
        self.executor.execute_task(conn, task_id, workspace_root=workspace_root)
        detail = self.get_task_detail(conn, task_id)
        if not detail:
            raise ValueError("Agent task not found.")
        return detail

    def handle_step_approval(
        self,
        conn: sqlite3.Connection,
        *,
        task_id: str,
        step_id: str,
        approved: bool,
        note: str | None = None,
        resume_execution: bool = True,
        workspace_root: str | None = None,
    ) -> dict[str, Any]:
        task = self.state_manager.get_task(conn, task_id)
        if not task:
            raise ValueError("Agent task not found.")
        steps = self.state_manager.list_steps(conn, task_id)
        step = next((s for s in steps if s["id"] == step_id), None)
        if not step:
            raise ValueError("Task step not found.")

        if approved:
            self.state_manager.update_step_state(
                conn,
                step["id"],
                status="approved",
                approval_status="approved",
                approval_note=(note or "").strip(),
            )
            self.state_manager.record_history(
                conn,
                task_id=task_id,
                step_id=step["id"],
                agent_id=task["agent_id"],
                event_type="approval_granted",
                tool_name=step["tool_name"],
                detail=f"Operator approved step '{step['title']}' ({step['tool_name']}).",
            )
            if resume_execution:
                self.executor.execute_task(conn, task_id, workspace_root=workspace_root)
        else:
            self.state_manager.update_step_state(
                conn,
                step["id"],
                status="rejected",
                approval_status="rejected",
                approval_note=(note or "Rejected by operator").strip(),
                error_message="Action rejected by operator.",
                completed_at=_utc_now(),
            )
            self.state_manager.update_task_state(
                conn,
                task_id,
                status="failed",
                current_step_index=step["step_index"],
                error_message=f"Step '{step['title']}' rejected by operator.",
                result_summary=f"Execution halted: operator rejected consequential action '{step['tool_name']}'.",
            )
            self.state_manager.record_history(
                conn,
                task_id=task_id,
                step_id=step["id"],
                agent_id=task["agent_id"],
                event_type="approval_rejected",
                tool_name=step["tool_name"],
                detail=f"Operator rejected step '{step['title']}' ({step['tool_name']}).",
            )
        return self.get_task_detail(conn, task_id)  # type: ignore[return-value]

    def cancel_task(self, conn: sqlite3.Connection, task_id: str) -> dict[str, Any]:
        task = self.state_manager.get_task(conn, task_id)
        if not task:
            raise ValueError("Agent task not found.")
        if task["status"] not in {"completed", "failed", "cancelled"}:
            self.state_manager.update_task_state(
                conn,
                task_id,
                status="cancelled",
                result_summary="Task cancelled by operator.",
                completed_at=_utc_now(),
            )
            self.state_manager.record_history(
                conn,
                task_id=task_id,
                agent_id=task["agent_id"],
                event_type="task_cancelled",
                detail=f"Task '{task['title']}' cancelled by operator.",
            )
        return self.get_task_detail(conn, task_id)  # type: ignore[return-value]

    def save_task_result_to_memory(
        self,
        conn: sqlite3.Connection,
        *,
        task_id: str,
        approved: bool,
        title: str | None = None,
        content: str | None = None,
        category: str = "fact",
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        if approved is not True:
            raise ValueError(
                "Explicit user approval (approved: true) is required before saving agent results to User Memory."
            )
        detail = self.get_task_detail(conn, task_id)
        if not detail:
            raise ValueError("Agent task not found.")

        mem_title = (title or f"Agent Task: {detail['task']['title']}").strip()[:160]
        mem_content = (content or detail["report"]["summary"]).strip()[:4000]
        if not mem_title or not mem_content:
            raise ValueError("Memory title and content cannot be empty.")
        secret_hit = detect_sensitive_secret(f"{mem_title}\n{mem_content}")
        if secret_hit:
            raise ValueError(f"Rejected for privacy: detected potential {secret_hit}.")

        safe_category = category if category in {"fact", "preference", "instruction", "constraint"} else "fact"
        safe_tags = [str(t).strip() for t in (tags or ["agent-result"]) if str(t).strip()][:20]
        mem_id = f"mem-{uuid.uuid4()}"
        now = _utc_now()

        conn.execute(
            """
            INSERT INTO memory_entries (
                id, namespace, category, title, content, tags_json, importance, approved, source_conversation_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (mem_id, "project", safe_category, mem_title, mem_content, json.dumps(safe_tags), 4, None, now, now),
        )
        if has_fts5_support(conn):
            conn.execute(
                "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
                (mem_id, mem_title, mem_content, " ".join(safe_tags)),
            )
        self.state_manager.record_history(
            conn,
            task_id=task_id,
            agent_id=detail["task"]["agent_id"],
            event_type="memory_saved",
            detail=f"Operator approved saving task summary '{mem_title}' into User Memory.",
            payload={"memory_id": mem_id, "category": safe_category},
        )
        conn.commit()
        return {"id": mem_id, "title": mem_title, "category": safe_category, "content": mem_content}

    def delete_task(self, conn: sqlite3.Connection, task_id: str) -> bool:
        return self.state_manager.delete_task(conn, task_id)

    def list_history(
        self, conn: sqlite3.Connection, *, task_id: str | None = None, limit: int = 80
    ) -> list[dict[str, Any]]:
        return self.state_manager.list_history(conn, task_id=task_id, limit=limit)


default_agent_manager = AgentManager()
