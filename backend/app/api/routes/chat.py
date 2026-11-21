import asyncio
import json
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from app.ai.interfaces import InferenceRequest
from app.ai.memory_retrieval import (
    SqliteKeywordRetriever,
    format_retrieved_system_context,
    search_conversation_history,
)
from app.ai.registry import build_context_messages, resolve_model_adapter
from app.ai.tokenizer import BaselineTokenizer
from app.api.deps import require_authenticated_session
from app.core.config import get_settings
from app.core.security import validate_attachment
from app.db.database import get_connection, get_core_settings, utc_now
from app.db.schemas import ConversationCreate, ConversationRename, MessageCreate, UploadValidatePayload

MAX_ATTACHMENTS_PER_MESSAGE = 10
MAX_PREVIEW_TEXT_CHARS = 4000

router = APIRouter(
    tags=["Chat"],
    dependencies=[Depends(require_authenticated_session)],
)
tokenizer = BaselineTokenizer()


def _format_inference_failure_fallback(
    error_detail: str,
    endpoint_url: str,
    user_tokens: int,
    user_bytes: int,
    attachment_count: int,
) -> str:
    payload_json = json.dumps(
        {
            "status": "demo_mode",
            "error": error_detail,
            "user_tokens_estimated": user_tokens,
            "user_bytes": user_bytes,
            "attachments_validated": attachment_count,
            "inference_endpoint": endpoint_url,
        },
        indent=2,
    )
    return "\n".join(
        [
            "### Demo Mode Fallback — Local Inference Endpoint Error",
            "",
            f"Attempted dispatch to `{endpoint_url or 'local adapter'}` did not complete: **{error_detail}**",
            "",
            "Project Genesis does **not** fall back to external AI APIs or fabricate model completions.",
            "",
            "```json",
            payload_json,
            "```",
        ]
    )


def _prepare_conversation_turn(conn, conversation_id: str, payload: MessageCreate) -> dict[str, object]:
    settings = get_settings()
    text = payload.content.strip()
    if not text and not payload.attachments:
        raise HTTPException(status_code=400, detail="Message content or attachment is required.")
    if len(payload.attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(
            status_code=400,
            detail=f"Too many attachments. Maximum {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.",
        )

    conv = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    core_cfg = get_core_settings(conn)
    allowed_exts = [str(e).lower() for e in core_cfg.get("allowed_extensions", settings.allowed_extension_list)]
    max_mb = int(core_cfg.get("max_upload_mb", settings.genesis_max_upload_mb))

    sanitized_attachments: list[dict[str, object]] = []
    for att in payload.attachments:
        ok, info = validate_attachment(att.name, att.size, allowed_exts, max_mb)
        if not ok:
            raise HTTPException(status_code=400, detail=info)
        if att.previewText is not None and len(att.previewText) > MAX_PREVIEW_TEXT_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"Attachment '{info}' previewText exceeds {MAX_PREVIEW_TEXT_CHARS} character limit.",
            )
        dumped = att.model_dump()
        dumped["name"] = info
        dumped["validated"] = True
        sanitized_attachments.append(dumped)

    effective_model_id = (
        payload.model_id
        if payload.model_id is not None
        else conv["model_id"]
        or ("local-inference-http" if core_cfg.get("prefer_local_inference") else "genesis-core-placeholder")
    )
    default_endpoint = str(core_cfg.get("inference_endpoint_url", settings.genesis_inference_url))
    try:
        adapter, model_row = resolve_model_adapter(conn, effective_model_id, default_endpoint)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    temperature = min(2.0, max(0.0, float(payload.temperature if payload.temperature is not None else core_cfg.get("inference_temperature", 0.2))))
    max_tokens = min(8192, max(32, round(float(payload.max_tokens if payload.max_tokens is not None else core_cfg.get("inference_max_tokens", 512)))))
    timeout_ms = min(120000, max(1000, round(float(payload.timeout_ms if payload.timeout_ms is not None else core_cfg.get("inference_timeout_ms", 30000)))))

    user_id = f"msg-{uuid.uuid4()}"
    now = utc_now()
    user_stats = tokenizer.inspect(text)
    user_meta = {"mode": "demo", "token_count": user_stats["token_count"]}
    next_title = (
        (text[:56] + ("..." if len(text) > 56 else ""))
        if conv["title"] == "New Conversation" and text
        else conv["title"]
    )

    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                conversation_id,
                "user",
                text,
                json.dumps(sanitized_attachments),
                json.dumps(user_meta),
                now,
            ),
        )
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (next_title, now, conversation_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return {
        "conv": dict(conv),
        "text": text,
        "user_stats": user_stats,
        "sanitized_attachments": sanitized_attachments,
        "core_cfg": core_cfg,
        "adapter": adapter,
        "model_row": model_row,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "timeout_seconds": timeout_ms / 1000.0,
        "use_memory": bool(payload.use_memory),
        "use_knowledge": bool(payload.use_knowledge),
        "user_message": {
            "id": user_id,
            "conversation_id": conversation_id,
            "role": "user",
            "content": text,
            "attachments": sanitized_attachments,
            "metadata": user_meta,
            "created_at": now,
        },
    }


def _load_packed_history(
    conn,
    conversation_id: str,
    context_length: int,
    max_tokens: int,
    query_text: str,
    use_memory: bool,
    use_knowledge: bool,
) -> tuple[list[dict[str, str]], int, int, dict[str, object]]:
    retriever = SqliteKeywordRetriever(conn)
    retrieval = retriever.retrieve(
        query_text,
        include_memory=use_memory,
        include_knowledge=use_knowledge,
        max_memory_items=3,
        max_knowledge_chunks=3,
        context_length=context_length,
    )
    system_context = format_retrieved_system_context(retrieval)

    rows = conn.execute(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 60",
        (conversation_id,),
    ).fetchall()
    history = [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
    packed_msgs, est_tokens, truncated_count = build_context_messages(
        history, context_length, max_tokens, system_context
    )
    summary = {
        "queried": bool(retrieval.get("queried", False)),
        "retrieval_backend": str(retrieval.get("retrieval_backend", "sqlite_like")),
        "memories_used": [
            {"id": m["id"], "title": m["title"], "category": m["category"]}
            for m in retrieval.get("memories", [])
        ],
        "knowledge_used": [
            {
                "document_id": k["document_id"],
                "document_title": k["document_title"],
                "chunk_index": k["chunk_index"],
            }
            for k in retrieval.get("knowledge", [])
        ],
        "total_context_tokens": int(retrieval.get("total_context_tokens", 0)),
    }
    return packed_msgs, est_tokens, truncated_count, summary


@router.post("/upload/validate")
def validate_upload_endpoint(payload: UploadValidatePayload) -> dict[str, object]:
    settings = get_settings()
    conn = get_connection()
    try:
        core_cfg = get_core_settings(conn)
    finally:
        conn.close()

    allowed_exts = [str(e).lower() for e in core_cfg.get("allowed_extensions", settings.allowed_extension_list)]
    max_mb = int(core_cfg.get("max_upload_mb", settings.genesis_max_upload_mb))

    ok, info = validate_attachment(payload.name, payload.size, allowed_exts, max_mb)
    if not ok:
        raise HTTPException(status_code=400, detail=info)

    ext = "." + info.rsplit(".", 1)[-1].lower() if "." in info else ""
    preview = payload.previewText[:MAX_PREVIEW_TEXT_CHARS] if isinstance(payload.previewText, str) else None
    return {
        "id": f"att-{uuid.uuid4()}",
        "name": info,
        "size": payload.size,
        "mimeType": payload.mimeType or "application/octet-stream",
        "extension": ext,
        "previewText": preview,
        "validated": True,
    }


@router.get("/conversations")
def list_conversations() -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
            FROM conversations c ORDER BY c.updated_at DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/conversations/search")
def search_conversations_route(q: str = "", limit: int = 20) -> dict[str, object]:
    conn = get_connection()
    try:
        matches = search_conversation_history(conn, q, limit)
        return {"query": q.strip(), "matches": matches}
    finally:
        conn.close()


@router.post("/conversations", status_code=201)
def create_conversation(payload: ConversationCreate) -> dict[str, object]:
    conn = get_connection()
    now = utc_now()
    conv_id = f"conv-{uuid.uuid4()}"
    title = payload.title.strip()[:120] or "New Conversation"
    try:
        core_cfg = get_core_settings(conn)
        resolved_model_id = (
            payload.model_id
            if payload.model_id is not None
            else ("local-inference-http" if core_cfg.get("prefer_local_inference") else "genesis-core-placeholder")
        )
        if resolved_model_id:
            model_row = conn.execute("SELECT id FROM models WHERE id = ?", (resolved_model_id,)).fetchone()
            if not model_row:
                raise HTTPException(status_code=404, detail=f'Model "{resolved_model_id}" not found in model registry.')
        conn.execute(
            "INSERT INTO conversations (id, title, module, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (conv_id, title, payload.module, resolved_model_id or "genesis-core-placeholder", now, now),
        )
        conn.commit()
        row = conn.execute("SELECT *, 0 AS message_count FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.patch("/conversations/{conversation_id}")
def update_conversation(conversation_id: str, payload: ConversationRename) -> dict[str, object]:
    conn = get_connection()
    try:
        existing = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        if payload.title is None and payload.model_id is None:
            raise HTTPException(status_code=400, detail="Title or model_id update is required.")

        next_title = existing["title"]
        if payload.title is not None:
            safe_title = payload.title.strip()[:120]
            if not safe_title:
                raise HTTPException(status_code=400, detail="Title cannot be empty.")
            next_title = safe_title

        next_model_id = existing["model_id"]
        if payload.model_id is not None:
            if payload.model_id:
                model_exists = conn.execute("SELECT id FROM models WHERE id = ?", (payload.model_id,)).fetchone()
                if not model_exists:
                    raise HTTPException(status_code=404, detail=f'Model "{payload.model_id}" not found in model registry.')
            next_model_id = payload.model_id

        conn.execute(
            "UPDATE conversations SET title = ?, model_id = ?, updated_at = ? WHERE id = ?",
            (next_title, next_model_id, utc_now(), conversation_id),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
            FROM conversations c WHERE c.id = ?
            """,
            (conversation_id,),
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        return {"deleted": True, "id": conversation_id}
    finally:
        conn.close()


@router.get("/conversations/{conversation_id}/messages")
def list_messages(conversation_id: str) -> list[dict[str, object]]:
    conn = get_connection()
    try:
        conv = conn.execute("SELECT id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "conversation_id": r["conversation_id"],
                "role": r["role"],
                "content": r["content"],
                "attachments": json.loads(r["attachments_json"] or "[]"),
                "metadata": json.loads(r["metadata_json"] or "{}"),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    finally:
        conn.close()


@router.post("/conversations/{conversation_id}/messages", status_code=201)
async def send_message(conversation_id: str, payload: MessageCreate) -> dict[str, object]:
    conn = get_connection()
    try:
        turn = _prepare_conversation_turn(conn, conversation_id, payload)
        adapter = turn["adapter"]
        model_row = turn["model_row"]
        user_stats = turn["user_stats"]
        core_cfg = turn["core_cfg"]
        sanitized_attachments = turn["sanitized_attachments"]
        max_tokens = int(turn["max_tokens"])  # type: ignore[arg-type]
        temperature = float(turn["temperature"])  # type: ignore[arg-type]
        timeout_seconds = float(turn["timeout_seconds"])  # type: ignore[arg-type]

        packed_msgs, est_prompt_tokens, truncated_count, retrieval_summary = _load_packed_history(
            conn,
            conversation_id,
            int(model_row["context_length"] or 8192),  # type: ignore[index]
            max_tokens,
            str(turn["text"]),
            bool(turn["use_memory"]),
            bool(turn["use_knowledge"]),
        )

        ai_resp = await adapter.generate(  # type: ignore[attr-defined]
            InferenceRequest(
                messages=packed_msgs,
                max_tokens=max_tokens,
                temperature=temperature,
                timeout_seconds=timeout_seconds,
            )
        )

        endpoint_note = str(model_row["endpoint_url"] or core_cfg.get("inference_endpoint_url") or "local-inference")  # type: ignore[index, call-overload]
        assistant_content = (
            ai_resp.content
            if ai_resp.ok
            else _format_inference_failure_fallback(
                ai_resp.error or "Local inference failed",
                endpoint_note,
                int(user_stats["token_count"]),  # type: ignore[index]
                int(user_stats["byte_count"]),  # type: ignore[index]
                len(sanitized_attachments),  # type: ignore[arg-type]
            )
        )
        assistant_id = f"msg-{uuid.uuid4()}"
        assistant_now = utc_now()
        assistant_meta = {
            "mode": ai_resp.mode if ai_resp.ok else "demo",
            "model_id": model_row["id"],  # type: ignore[index]
            "model_name": ai_resp.model_name,
            "token_count": tokenizer.inspect(assistant_content)["token_count"],
            "prompt_tokens": ai_resp.usage.get("prompt_tokens", est_prompt_tokens),
            "completion_tokens": ai_resp.usage.get("completion_tokens"),
            "finish_reason": ai_resp.finish_reason,
            "truncated_messages": truncated_count,
            "diagnostic": (not ai_resp.ok) or ai_resp.diagnostic,
            "memory_retrieval": retrieval_summary,
        }

        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    assistant_id,
                    conversation_id,
                    "assistant",
                    assistant_content,
                    "[]",
                    json.dumps(assistant_meta),
                    assistant_now,
                ),
            )
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (assistant_now, conversation_id),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        return {
            "user_message": turn["user_message"],
            "assistant_message": {
                "id": assistant_id,
                "conversation_id": conversation_id,
                "role": "assistant",
                "content": assistant_content,
                "attachments": [],
                "metadata": assistant_meta,
                "created_at": assistant_now,
            },
        }
    finally:
        conn.close()


@router.post("/conversations/{conversation_id}/messages/stream")
async def stream_message(conversation_id: str, payload: MessageCreate, request: Request) -> StreamingResponse:
    conn = get_connection()
    try:
        turn = _prepare_conversation_turn(conn, conversation_id, payload)
        adapter = turn["adapter"]
        model_row = turn["model_row"]
        user_stats = turn["user_stats"]
        core_cfg = turn["core_cfg"]
        sanitized_attachments = turn["sanitized_attachments"]
        max_tokens = int(turn["max_tokens"])  # type: ignore[arg-type]
        temperature = float(turn["temperature"])  # type: ignore[arg-type]
        timeout_seconds = float(turn["timeout_seconds"])  # type: ignore[arg-type]
        packed_msgs, est_prompt_tokens, truncated_count, retrieval_summary = _load_packed_history(
            conn,
            conversation_id,
            int(model_row["context_length"] or 8192),  # type: ignore[index]
            max_tokens,
            str(turn["text"]),
            bool(turn["use_memory"]),
            bool(turn["use_knowledge"]),
        )
    except Exception:
        conn.close()
        raise

    def sse_event(name: str, data: object) -> str:
        return f"event: {name}\ndata: {json.dumps(data)}\n\n"

    async def event_generator():
        accumulated = ""
        final_mode = "demo"
        final_model_name = str(model_row["name"])  # type: ignore[index]
        final_finish_reason = "stop"
        final_usage: dict[str, int] = {}
        is_diagnostic = False
        stream_error: str | None = None
        cancelled = False

        try:
            caps = adapter.get_capabilities()  # type: ignore[attr-defined]
            yield sse_event(
                "start",
                {
                    "user_message": turn["user_message"],
                    "model_id": model_row["id"],  # type: ignore[index]
                    "capabilities": {
                        "max_context_tokens": caps.max_context_tokens,
                        "supports_streaming": caps.supports_streaming,
                        "supports_tool_calling": caps.supports_tool_calling,
                        "provider": caps.provider,
                    },
                    "context_tokens_estimated": est_prompt_tokens,
                    "truncated_messages": truncated_count,
                    "memory_retrieval": retrieval_summary,
                },
            )

            async for chunk in adapter.generate_stream(  # type: ignore[attr-defined]
                InferenceRequest(
                    messages=packed_msgs,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    timeout_seconds=timeout_seconds,
                )
            ):
                if await request.is_disconnected():
                    cancelled = True
                    final_finish_reason = "cancelled"
                    break

                if chunk.type == "delta" and chunk.delta:
                    accumulated += chunk.delta
                    if chunk.mode:
                        final_mode = chunk.mode
                    if chunk.model_name:
                        final_model_name = chunk.model_name
                    yield sse_event(
                        "delta",
                        {
                            "delta": chunk.delta,
                            "accumulated_length": len(accumulated),
                            "model_name": final_model_name,
                        },
                    )
                elif chunk.type == "done":
                    if chunk.content is not None and (not accumulated or len(chunk.content) >= len(accumulated)):
                        accumulated = chunk.content
                    final_mode = chunk.mode or final_mode
                    final_model_name = chunk.model_name or final_model_name
                    final_finish_reason = chunk.finish_reason or "stop"
                    final_usage = chunk.usage or {}
                    is_diagnostic = bool(chunk.diagnostic)
                elif chunk.type == "error":
                    stream_error = chunk.error or "Inference stream interrupted."
                    final_finish_reason = chunk.finish_reason or "error"
                    if chunk.model_name:
                        final_model_name = chunk.model_name
                    break
        except asyncio.CancelledError:
            cancelled = True
            final_finish_reason = "cancelled"
        except Exception as exc:
            stream_error = str(exc)
            final_finish_reason = "error"

        endpoint_note = str(model_row["endpoint_url"] or core_cfg.get("inference_endpoint_url") or "local-inference")  # type: ignore[index, call-overload]
        partial = False
        if cancelled:
            final_finish_reason = "cancelled"
            if accumulated.strip():
                persisted_content = accumulated
                persisted_mode = final_mode
                partial = True
            else:
                persisted_content = "### Generation Cancelled\n\nInference was cancelled by the operator before any tokens were emitted."
                persisted_mode = "demo"
                is_diagnostic = True
        elif stream_error:
            if accumulated.strip():
                partial = True
                persisted_content = f"{accumulated}\n\n---\n\n> **Stream Interrupted**: {stream_error}"
                persisted_mode = final_mode
            else:
                persisted_content = _format_inference_failure_fallback(
                    stream_error,
                    endpoint_note,
                    int(user_stats["token_count"]),  # type: ignore[index]
                    int(user_stats["byte_count"]),  # type: ignore[index]
                    len(sanitized_attachments),  # type: ignore[arg-type]
                )
                persisted_mode = "demo"
                is_diagnostic = True
        else:
            persisted_content = accumulated
            persisted_mode = final_mode

        assistant_id = f"msg-{uuid.uuid4()}"
        assistant_now = utc_now()
        assistant_meta = {
            "mode": persisted_mode,
            "model_id": model_row["id"],  # type: ignore[index]
            "model_name": final_model_name,
            "token_count": tokenizer.inspect(persisted_content)["token_count"],
            "prompt_tokens": final_usage.get("prompt_tokens", est_prompt_tokens),
            "completion_tokens": final_usage.get("completion_tokens"),
            "finish_reason": final_finish_reason,
            "truncated_messages": truncated_count,
            "partial": partial,
            "diagnostic": is_diagnostic,
            "memory_retrieval": retrieval_summary,
        }

        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    assistant_id,
                    conversation_id,
                    "assistant",
                    persisted_content,
                    "[]",
                    json.dumps(assistant_meta),
                    assistant_now,
                ),
            )
            conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (assistant_now, conversation_id))
            conn.commit()
        finally:
            conn.close()

        assistant_message = {
            "id": assistant_id,
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": persisted_content,
            "attachments": [],
            "metadata": assistant_meta,
            "created_at": assistant_now,
        }
        if not cancelled:
            if stream_error:
                yield sse_event("error", {"error": stream_error, "assistant_message": assistant_message})
            else:
                yield sse_event("done", {"assistant_message": assistant_message})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
