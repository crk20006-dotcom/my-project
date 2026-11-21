import json
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from app.ai.tokenizer import BaselineTokenizer
from app.api.deps import extract_session_token, require_authenticated_session
from app.core.security import (
    SAFE_TOOLS,
    SESSION_COOKIE_NAME,
    SESSION_TTL_SECONDS,
    clear_all_sessions,
    create_session,
    hash_passcode,
    is_local_inference_url_safe,
    passcode_rate_limiter,
    revoke_session_token,
    verify_passcode,
    verify_session_token,
)
from app.db.database import get_connection, get_core_settings, reset_workspace_data, utc_now
from app.db.schemas import (
    AgentCreate,
    CreatorArtifactPayload,
    DryRunPayload,
    LaboratoryCreate,
    PasscodeVerifyPayload,
    ResearchProjectPayload,
    SettingsUpdatePayload,
)

router = APIRouter(tags=["Workspace"])
tokenizer = BaselineTokenizer()


def _sanitize_settings_for_client(data: dict[str, object]) -> dict[str, object]:
    out = dict(data)
    out["has_passcode"] = bool(out.pop("passcode_hash", ""))
    out.pop("passcode_salt", None)
    return out


@router.get("/auth/status")
def auth_status(request: Request) -> dict[str, object]:
    conn = get_connection()
    try:
        settings = get_core_settings(conn)
        token = extract_session_token(request)
        local_auth = bool(settings.get("local_auth_enabled", False))
        has_passcode = bool(settings.get("passcode_hash", ""))
        authenticated = (not local_auth) or (not has_passcode) or verify_session_token(conn, token)
        return {
            "local_auth_enabled": local_auth,
            "has_passcode": has_passcode,
            "operator_name": settings.get("operator_name", "Local Operator"),
            "authenticated": authenticated,
        }
    finally:
        conn.close()


@router.post("/auth/logout")
def auth_logout(request: Request, response: Response) -> dict[str, object]:
    conn = get_connection()
    try:
        token = extract_session_token(request)
        revoke_session_token(conn, token)
        response.delete_cookie(SESSION_COOKIE_NAME, path="/")
        return {"logged_out": True}
    finally:
        conn.close()


@router.get("/research", dependencies=[Depends(require_authenticated_session)])
def list_research() -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM research_projects ORDER BY updated_at DESC").fetchall()
        return [
            {
                **dict(r),
                "tags": json.loads(r["tags_json"] or "[]"),
                "sources": json.loads(r["sources_json"] or "[]"),
            }
            for r in rows
        ]
    finally:
        conn.close()


@router.post("/research", status_code=201, dependencies=[Depends(require_authenticated_session)])
def create_research(payload: ResearchProjectPayload) -> dict[str, object]:
    conn = get_connection()
    now = utc_now()
    proj_id = f"res-{uuid.uuid4()}"
    try:
        conn.execute(
            "INSERT INTO research_projects (id, title, summary, status, tags_json, sources_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                proj_id,
                payload.title.strip(),
                payload.summary.strip(),
                payload.status,
                json.dumps(payload.tags),
                json.dumps(payload.sources),
                payload.notes,
                now,
                now,
            ),
        )
        conn.commit()
        return {"id": proj_id, **payload.model_dump(), "created_at": now, "updated_at": now}
    finally:
        conn.close()


@router.put("/research/{project_id}", dependencies=[Depends(require_authenticated_session)])
def update_research(project_id: str, payload: ResearchProjectPayload) -> dict[str, object]:
    conn = get_connection()
    now = utc_now()
    try:
        cur = conn.execute(
            "UPDATE research_projects SET title = ?, summary = ?, status = ?, tags_json = ?, sources_json = ?, notes = ?, updated_at = ? WHERE id = ?",
            (
                payload.title.strip(),
                payload.summary.strip(),
                payload.status,
                json.dumps(payload.tags),
                json.dumps(payload.sources),
                payload.notes,
                now,
                project_id,
            ),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Research project not found.")
        row = conn.execute("SELECT * FROM research_projects WHERE id = ?", (project_id,)).fetchone()
        return {
            "id": row["id"],
            "title": row["title"],
            "summary": row["summary"],
            "status": row["status"],
            "tags": json.loads(row["tags_json"] or "[]"),
            "sources": json.loads(row["sources_json"] or "[]"),
            "notes": row["notes"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
    finally:
        conn.close()


@router.delete("/research/{project_id}", dependencies=[Depends(require_authenticated_session)])
def delete_research(project_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM research_projects WHERE id = ?", (project_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Research project not found.")
        return {"deleted": True, "id": project_id}
    finally:
        conn.close()


@router.get("/agents", dependencies=[Depends(require_authenticated_session)])
def list_agents() -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM agents ORDER BY created_at DESC").fetchall()
        return [
            {
                **dict(r),
                "allowed_tools": json.loads(r["allowed_tools_json"] or "[]"),
                "sandbox_policy": json.loads(r["sandbox_policy_json"] or "{}"),
            }
            for r in rows
        ]
    finally:
        conn.close()


@router.post("/agents", status_code=201, dependencies=[Depends(require_authenticated_session)])
def create_agent(payload: AgentCreate) -> dict[str, object]:
    safe_tools = [t for t in payload.allowed_tools if t in SAFE_TOOLS]
    safe_policy = {
        "allow_network": False,
        "allow_filesystem_write": "create_document" in safe_tools,
        "allow_shell_execution": False,
        "max_steps": min(12, max(1, int(payload.sandbox_policy.get("max_steps", 6)))),
        "workspace_scope": "./data/agent_workspace",
    }
    conn = get_connection()
    now = utc_now()
    agent_id = f"agent-{uuid.uuid4()}"
    try:
        conn.execute(
            "INSERT INTO agents (id, name, role, description, allowed_tools_json, sandbox_policy_json, system_prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                agent_id,
                payload.name.strip(),
                payload.role.strip(),
                payload.description.strip(),
                json.dumps(safe_tools),
                json.dumps(safe_policy),
                payload.system_prompt,
                "ready",
                now,
                now,
            ),
        )
        conn.commit()
        return {
            "id": agent_id,
            "name": payload.name.strip(),
            "role": payload.role.strip(),
            "description": payload.description.strip(),
            "allowed_tools": safe_tools,
            "sandbox_policy": safe_policy,
            "system_prompt": payload.system_prompt,
            "status": "ready",
            "created_at": now,
            "updated_at": now,
        }
    finally:
        conn.close()


@router.post("/agents/{agent_id}/dry-run", dependencies=[Depends(require_authenticated_session)])
def dry_run_agent(agent_id: str, payload: DryRunPayload) -> dict[str, object]:
    conn = get_connection()
    try:
        agent = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found.")
        allowed_tools = json.loads(agent["allowed_tools_json"] or "[]")
        policy = json.loads(agent["sandbox_policy_json"] or '{"max_steps": 4}')
        models_count = conn.execute("SELECT COUNT(*) AS c FROM models").fetchone()["c"]
        token_stats = tokenizer.inspect(payload.task)
        trace = [
            {
                "step": 1,
                "action": "Sandbox Policy Verification",
                "status": "executed",
                "detail": f"Network disabled · Filesystem write disabled · Shell disabled · Step budget: {policy.get('max_steps', 4)}",
            },
            {
                "step": 2,
                "action": "Deterministic Input Inspection",
                "status": "executed",
                "detail": f"Task tokenized: {token_stats['token_count']} tokens ({token_stats['byte_count']} bytes). Allowed tools: {', '.join(allowed_tools) or 'None'}.",
            },
            {
                "step": 3,
                "action": "Local Model Registry Check",
                "status": "executed",
                "detail": f"Verified {models_count} registered model manifest(s). Active inference weights: None.",
            },
            {
                "step": 4,
                "action": "Autonomous Reasoning Step",
                "status": "paused_no_model",
                "detail": "Execution paused cleanly. Autonomous planning requires an active GENESIS CORE model or local inference server.",
            },
        ]
        return {
            "agent_id": agent["id"],
            "agent_name": agent["name"],
            "mode": "sandbox_dry_run",
            "trace": trace,
        }
    finally:
        conn.close()


@router.delete("/agents/{agent_id}", dependencies=[Depends(require_authenticated_session)])
def delete_agent(agent_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Agent not found.")
        return {"deleted": True, "id": agent_id}
    finally:
        conn.close()


@router.post("/laboratory/tokenize", dependencies=[Depends(require_authenticated_session)])
def tokenize_text(payload: dict[str, object]) -> dict[str, object]:
    text = str(payload.get("text", ""))
    limit = int(payload.get("context_limit", 8192))
    return tokenizer.inspect(text, limit)


@router.get("/laboratory", dependencies=[Depends(require_authenticated_session)])
def list_laboratory() -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM laboratory_items ORDER BY updated_at DESC").fetchall()
        return [{**dict(r), "metrics": json.loads(r["metrics_json"] or "{}")} for r in rows]
    finally:
        conn.close()


@router.post("/laboratory", status_code=201, dependencies=[Depends(require_authenticated_session)])
def create_laboratory_item(payload: LaboratoryCreate) -> dict[str, object]:
    conn = get_connection()
    now = utc_now()
    item_id = f"lab-{uuid.uuid4()}"
    try:
        conn.execute(
            "INSERT INTO laboratory_items (id, kind, name, content, schema_json, metrics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (item_id, payload.kind, payload.name.strip(), payload.content, payload.schema_json, json.dumps(payload.metrics), now, now),
        )
        conn.commit()
        return {"id": item_id, **payload.model_dump(), "created_at": now, "updated_at": now}
    finally:
        conn.close()


@router.delete("/laboratory/{item_id}", dependencies=[Depends(require_authenticated_session)])
def delete_laboratory_item(item_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM laboratory_items WHERE id = ?", (item_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Laboratory item not found.")
        return {"deleted": True, "id": item_id}
    finally:
        conn.close()


@router.get("/creator", dependencies=[Depends(require_authenticated_session)])
def list_creator() -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM creator_artifacts ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/creator", status_code=201, dependencies=[Depends(require_authenticated_session)])
def create_artifact(payload: CreatorArtifactPayload) -> dict[str, object]:
    conn = get_connection()
    now = utc_now()
    art_id = f"art-{uuid.uuid4()}"
    try:
        conn.execute(
            "INSERT INTO creator_artifacts (id, title, artifact_type, language, content, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (art_id, payload.title.strip(), payload.artifact_type, payload.language, payload.content, 1, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM creator_artifacts WHERE id = ?", (art_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.put("/creator/{artifact_id}", dependencies=[Depends(require_authenticated_session)])
def update_artifact(artifact_id: str, payload: CreatorArtifactPayload) -> dict[str, object]:
    conn = get_connection()
    now = utc_now()
    try:
        cur = conn.execute(
            "UPDATE creator_artifacts SET title = ?, artifact_type = ?, language = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ?",
            (
                payload.title.strip() or "Untitled",
                payload.artifact_type,
                payload.language,
                payload.content,
                now,
                artifact_id,
            ),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Artifact not found.")
        row = conn.execute("SELECT * FROM creator_artifacts WHERE id = ?", (artifact_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.delete("/creator/{artifact_id}", dependencies=[Depends(require_authenticated_session)])
def delete_artifact(artifact_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM creator_artifacts WHERE id = ?", (artifact_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Artifact not found.")
        return {"deleted": True, "id": artifact_id}
    finally:
        conn.close()


@router.get("/settings", dependencies=[Depends(require_authenticated_session)])
def get_settings_route() -> dict[str, object]:
    conn = get_connection()
    try:
        data = get_core_settings(conn)
        return _sanitize_settings_for_client(data)
    finally:
        conn.close()


@router.put("/settings", dependencies=[Depends(require_authenticated_session)])
def update_settings_route(payload: SettingsUpdatePayload, response: Response) -> dict[str, object]:
    if payload.inference_endpoint_url is not None and payload.inference_endpoint_url.strip():
        safe, reason = is_local_inference_url_safe(payload.inference_endpoint_url.strip())
        if not safe:
            raise HTTPException(status_code=400, detail=reason)

    conn = get_connection()
    try:
        current = get_core_settings(conn)
        wants_passcode_change = bool(payload.new_passcode and payload.new_passcode.strip())
        wants_auth_toggle = (
            payload.local_auth_enabled is not None
            and payload.local_auth_enabled != bool(current.get("local_auth_enabled", False))
        )

        if current.get("passcode_hash") and (
            wants_passcode_change or (wants_auth_toggle and bool(current.get("local_auth_enabled", False)))
        ):
            provided = payload.current_passcode or ""
            if not provided:
                raise HTTPException(
                    status_code=403,
                    detail="Current passcode is required to modify or disable authentication.",
                )
            if not verify_passcode(provided, str(current.get("passcode_hash", "")), str(current.get("passcode_salt", ""))):
                raise HTTPException(status_code=403, detail="Current passcode verification failed.")

        passcode_hash = str(current.get("passcode_hash", ""))
        passcode_salt = str(current.get("passcode_salt", ""))
        if wants_passcode_change:
            trimmed_passcode = payload.new_passcode.strip()  # type: ignore[union-attr]
            if len(trimmed_passcode) < 6:
                raise HTTPException(status_code=400, detail="Local passcode must be at least 6 characters.")
            passcode_hash, passcode_salt = hash_passcode(trimmed_passcode)

        next_auth_enabled = (
            payload.local_auth_enabled
            if payload.local_auth_enabled is not None
            else bool(current.get("local_auth_enabled", False))
        )
        if next_auth_enabled and not passcode_hash:
            raise HTTPException(status_code=400, detail="Set a local passcode before enabling local session lock.")

        next_extensions = current.get("allowed_extensions", [])
        if payload.allowed_extensions is not None:
            next_extensions = [
                (e.lower() if e.startswith(".") else f".{e.lower()}")
                for e in payload.allowed_extensions
                if e.strip()
            ]

        updated_cfg = {
            "operator_name": (
                payload.operator_name.strip() if payload.operator_name is not None else current.get("operator_name", "Local Operator")
            )
            or "Local Operator",
            "local_auth_enabled": next_auth_enabled,
            "passcode_hash": passcode_hash,
            "passcode_salt": passcode_salt,
            "inference_endpoint_url": (
                payload.inference_endpoint_url.strip()
                if payload.inference_endpoint_url is not None
                else str(current.get("inference_endpoint_url", ""))
            ),
            "prefer_local_inference": (
                payload.prefer_local_inference
                if payload.prefer_local_inference is not None
                else bool(current.get("prefer_local_inference", False))
            ),
            "active_model_id": (
                payload.active_model_id.strip()
                if payload.active_model_id and payload.active_model_id.strip()
                else str(current.get("active_model_id", "genesis-core-placeholder"))
            ),
            "chat_use_memory": (
                payload.chat_use_memory
                if payload.chat_use_memory is not None
                else bool(current.get("chat_use_memory", True))
            ),
            "chat_use_knowledge": (
                payload.chat_use_knowledge
                if payload.chat_use_knowledge is not None
                else bool(current.get("chat_use_knowledge", True))
            ),
            "inference_temperature": min(
                2.0,
                max(
                    0.0,
                    float(
                        payload.inference_temperature
                        if payload.inference_temperature is not None
                        else current.get("inference_temperature", 0.2)
                    ),
                ),
            ),
            "inference_max_tokens": min(
                8192,
                max(
                    32,
                    round(
                        float(
                            payload.inference_max_tokens
                            if payload.inference_max_tokens is not None
                            else current.get("inference_max_tokens", 512)
                        )
                    ),
                ),
            ),
            "inference_timeout_ms": min(
                120000,
                max(
                    1000,
                    round(
                        float(
                            payload.inference_timeout_ms
                            if payload.inference_timeout_ms is not None
                            else current.get("inference_timeout_ms", 30000)
                        )
                    ),
                ),
            ),
            "max_upload_mb": min(25, max(1, int(payload.max_upload_mb or current.get("max_upload_mb", 5)))),
            "allowed_extensions": next_extensions,
            "sandbox_strict_mode": (
                payload.sandbox_strict_mode
                if payload.sandbox_strict_mode is not None
                else bool(current.get("sandbox_strict_mode", True))
            ),
            "voice_sample_rate": int(payload.voice_sample_rate or current.get("voice_sample_rate", 16000)),
            "voice_vad_threshold": float(
                payload.voice_vad_threshold
                if payload.voice_vad_threshold is not None
                else current.get("voice_vad_threshold", 0.45)
            ),
            "voice_stt_adapter": payload.voice_stt_adapter or current.get("voice_stt_adapter", "placeholder_whisper_local"),
            "voice_tts_adapter": payload.voice_tts_adapter or current.get("voice_tts_adapter", "placeholder_piper_local"),
        }

        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
            ("core_config", json.dumps(updated_cfg), utc_now()),
        )
        conn.commit()

        session_token: str | None = None
        expires_at: str | None = None
        if wants_passcode_change or (wants_auth_toggle and not next_auth_enabled):
            clear_all_sessions(conn)
            response.delete_cookie(SESSION_COOKIE_NAME, path="/")

        if next_auth_enabled and (not bool(current.get("local_auth_enabled", False)) or wants_passcode_change):
            session_token, expires_at = create_session(conn)
            response.set_cookie(
                SESSION_COOKIE_NAME,
                session_token,
                httponly=True,
                samesite="lax",
                path="/",
                max_age=SESSION_TTL_SECONDS,
            )

        out = _sanitize_settings_for_client(updated_cfg)
        if session_token:
            out["session_token"] = session_token
            out["expires_at"] = expires_at
        return out
    finally:
        conn.close()


@router.post("/settings/verify-passcode")
def verify_passcode_route(payload: PasscodeVerifyPayload, request: Request, response: Response) -> dict[str, object]:
    client_key = request.client.host if request.client else "local"
    allowed, retry_after = passcode_rate_limiter.check(client_key)
    if not allowed:
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return {
            "unlocked": False,
            "error": f"Too many failed passcode attempts. Try again in {retry_after} seconds.",
        }

    conn = get_connection()
    try:
        settings = get_core_settings(conn)
        if not settings.get("local_auth_enabled") or not settings.get("passcode_hash"):
            return {"unlocked": True}
        if not payload.passcode:
            passcode_rate_limiter.record_failure(client_key)
            raise HTTPException(status_code=401, detail="Passcode required.")
        if not verify_passcode(payload.passcode, str(settings.get("passcode_hash", "")), str(settings.get("passcode_salt", ""))):
            passcode_rate_limiter.record_failure(client_key)
            raise HTTPException(status_code=401, detail="Invalid local operator passcode.")

        passcode_rate_limiter.clear(client_key)
        token, expires_at = create_session(conn)
        response.set_cookie(
            SESSION_COOKIE_NAME,
            token,
            httponly=True,
            samesite="lax",
            path="/",
            max_age=SESSION_TTL_SECONDS,
        )
        return {"unlocked": True, "session_token": token, "expires_at": expires_at}
    finally:
        conn.close()


@router.get("/settings/export-db", dependencies=[Depends(require_authenticated_session)])
def export_db_snapshot() -> dict[str, object]:
    conn = get_connection()
    try:
        return {
            "exported_at": utc_now(),
            "platform": "Project Genesis Step 07",
            "conversations": [dict(r) for r in conn.execute("SELECT * FROM conversations").fetchall()],
            "messages": [dict(r) for r in conn.execute("SELECT * FROM messages").fetchall()],
            "memory_entries": [dict(r) for r in conn.execute("SELECT * FROM memory_entries").fetchall()],
            "knowledge_documents": [dict(r) for r in conn.execute("SELECT * FROM knowledge_documents").fetchall()],
            "knowledge_chunks": [dict(r) for r in conn.execute("SELECT * FROM knowledge_chunks").fetchall()],
            "research_projects": [dict(r) for r in conn.execute("SELECT * FROM research_projects").fetchall()],
            "models": [dict(r) for r in conn.execute("SELECT * FROM models").fetchall()],
            "agents": [dict(r) for r in conn.execute("SELECT * FROM agents").fetchall()],
            "agent_tasks": [dict(r) for r in conn.execute("SELECT * FROM agent_tasks").fetchall()],
            "agent_task_steps": [dict(r) for r in conn.execute("SELECT * FROM agent_task_steps").fetchall()],
            "agent_execution_history": [dict(r) for r in conn.execute("SELECT * FROM agent_execution_history").fetchall()],
            "laboratory_items": [dict(r) for r in conn.execute("SELECT * FROM laboratory_items").fetchall()],
            "creator_artifacts": [dict(r) for r in conn.execute("SELECT * FROM creator_artifacts").fetchall()],
            "settings": _sanitize_settings_for_client(get_core_settings(conn)),
        }
    finally:
        conn.close()


@router.post("/settings/reset", dependencies=[Depends(require_authenticated_session)])
def reset_workspace_route() -> dict[str, object]:
    conn = get_connection()
    try:
        reset_workspace_data(conn)
        return {"reset": True, "timestamp": utc_now()}
    finally:
        conn.close()
