from fastapi import APIRouter, Depends, HTTPException, Query
from app.agent.agent_manager import default_agent_manager
from app.api.deps import require_authenticated_session
from app.db.database import get_connection
from app.db.schemas import AgentTaskCreate, AgentTaskMemorySavePayload, AgentTaskStepApprovalPayload

router = APIRouter(tags=["Agents"], dependencies=[Depends(require_authenticated_session)])


@router.get("/agent-tools")
def list_agent_tools() -> list[dict[str, object]]:
    return default_agent_manager.list_tools()


@router.get("/agent-tasks")
def list_agent_tasks(status: str | None = Query(default=None)) -> list[dict[str, object]]:
    conn = get_connection()
    try:
        return default_agent_manager.list_tasks(conn, status=status)
    finally:
        conn.close()


@router.post("/agent-tasks", status_code=201)
def create_agent_task(payload: AgentTaskCreate) -> dict[str, object]:
    if not payload.agent_id.strip() or not payload.goal.strip():
        raise HTTPException(status_code=400, detail="agent_id and goal are required.")
    conn = get_connection()
    try:
        return default_agent_manager.create_and_plan_task(
            conn,
            agent_id=payload.agent_id.strip(),
            goal=payload.goal.strip(),
            title=payload.title,
            target_file_path=payload.target_file_path,
            document_filename=payload.document_filename,
            code_snippet=payload.code_snippet,
            max_retries=payload.max_retries,
            auto_run=payload.auto_run,
        )
    except ValueError as exc:
        msg = str(exc)
        raise HTTPException(status_code=404 if "not found" in msg.lower() else 400, detail=msg)
    finally:
        conn.close()


@router.get("/agent-tasks/{task_id}")
def get_agent_task(task_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        detail = default_agent_manager.get_task_detail(conn, task_id)
        if not detail:
            raise HTTPException(status_code=404, detail="Agent task not found.")
        return detail
    finally:
        conn.close()


@router.post("/agent-tasks/{task_id}/run")
def run_agent_task(task_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        return default_agent_manager.run_task(conn, task_id)
    except ValueError as exc:
        msg = str(exc)
        raise HTTPException(status_code=404 if "not found" in msg.lower() else 400, detail=msg)
    finally:
        conn.close()


@router.post("/agent-tasks/{task_id}/steps/{step_id}/approve")
def approve_agent_task_step(
    task_id: str, step_id: str, payload: AgentTaskStepApprovalPayload
) -> dict[str, object]:
    conn = get_connection()
    try:
        return default_agent_manager.handle_step_approval(
            conn,
            task_id=task_id,
            step_id=step_id,
            approved=payload.approved,
            note=payload.note,
            resume_execution=payload.resume,
        )
    except ValueError as exc:
        msg = str(exc)
        raise HTTPException(status_code=404 if "not found" in msg.lower() else 400, detail=msg)
    finally:
        conn.close()


@router.post("/agent-tasks/{task_id}/cancel")
def cancel_agent_task(task_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        return default_agent_manager.cancel_task(conn, task_id)
    except ValueError as exc:
        msg = str(exc)
        raise HTTPException(status_code=404 if "not found" in msg.lower() else 400, detail=msg)
    finally:
        conn.close()


@router.post("/agent-tasks/{task_id}/save-memory", status_code=201)
def save_agent_task_memory(
    task_id: str, payload: AgentTaskMemorySavePayload
) -> dict[str, object]:
    conn = get_connection()
    try:
        return default_agent_manager.save_task_result_to_memory(
            conn,
            task_id=task_id,
            approved=payload.approved is True,
            title=payload.title,
            content=payload.content,
            category=payload.category,
            tags=payload.tags,
        )
    except ValueError as exc:
        msg = str(exc)
        raise HTTPException(status_code=404 if "not found" in msg.lower() else 400, detail=msg)
    finally:
        conn.close()


@router.delete("/agent-tasks/{task_id}")
def delete_agent_task(task_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        deleted = default_agent_manager.delete_task(conn, task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Agent task not found.")
        return {"deleted": True, "id": task_id}
    finally:
        conn.close()


@router.get("/agent-history")
def list_agent_history(
    task_id: str | None = Query(default=None), limit: int = Query(default=80, ge=1, le=200)
) -> list[dict[str, object]]:
    conn = get_connection()
    try:
        return default_agent_manager.list_history(conn, task_id=task_id, limit=limit)
    finally:
        conn.close()
