from typing import Any


class AgentResultReporter:
    def build_report(self, task: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
        completed = sum(1 for s in steps if s["status"] == "completed")
        failed = sum(1 for s in steps if s["status"] in {"failed", "rejected"})
        pending_approvals = sum(1 for s in steps if s["status"] == "awaiting_approval")

        artifacts: list[dict[str, Any]] = []
        outcomes: list[dict[str, Any]] = []
        for s in steps:
            out_obj = s.get("output") or {}
            data_obj = out_obj.get("data") or {}
            if s["tool_name"] == "create_document" and s["status"] == "completed" and isinstance(data_obj.get("path"), str):
                artifacts.append({"path": data_obj["path"], "bytes": int(data_obj.get("bytes", 0))})
            summary_txt = (
                out_obj.get("summary")
                if isinstance(out_obj.get("summary"), str)
                else "Paused awaiting explicit operator approval."
                if s["status"] == "awaiting_approval"
                else s.get("error_message") or "Pending execution."
            )
            item: dict[str, Any] = {
                "step_index": s["step_index"],
                "title": s["title"],
                "tool_name": s["tool_name"],
                "status": s["status"],
                "summary": summary_txt,
            }
            if s.get("error_message"):
                item["error"] = s["error_message"]
            outcomes.append(item)

        summary = task.get("result_summary") or ""
        if not summary:
            status = task["status"]
            if status == "completed":
                summary = f"Completed {completed}/{len(steps)} step(s)."
                if artifacts:
                    summary += f" Created {len(artifacts)} document(s)."
            elif status == "awaiting_approval":
                summary = f"Execution paused at step {int(task['current_step_index']) + 1}/{len(steps)} awaiting operator approval."
            elif status == "failed":
                summary = task.get("error_message") or f"Execution failed with {failed} failed step(s)."
            elif status == "cancelled":
                summary = "Task cancelled by operator."
            else:
                summary = f"Planned {len(steps)} sequential step(s); ready to execute."

        return {
            "task_id": task["id"],
            "title": task["title"],
            "status": task["status"],
            "completed_steps": completed,
            "total_steps": len(steps),
            "failed_steps": failed,
            "pending_approvals": pending_approvals,
            "summary": summary,
            "artifacts_created": artifacts,
            "step_outcomes": outcomes,
        }


default_result_reporter = AgentResultReporter()
