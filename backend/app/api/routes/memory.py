import json
import uuid
from fastapi import APIRouter, Depends, HTTPException
from app.ai.memory_retrieval import (
    SqliteKeywordRetriever,
    chunk_knowledge_text,
    format_retrieved_system_context,
)
from app.api.deps import require_authenticated_session
from app.core.security import detect_sensitive_secret
from app.db.database import get_connection, has_fts5_support, utc_now
from app.db.schemas import (
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    MemoryCreate,
    MemoryUpdate,
    RetrievalQueryPayload,
)

router = APIRouter(
    tags=["Memory"],
    dependencies=[Depends(require_authenticated_session)],
)

VALID_MEMORY_CATEGORIES = {"fact", "preference", "instruction", "constraint"}


@router.get("/memory/status")
def memory_system_status() -> dict[str, object]:
    conn = get_connection()
    try:
        total_memories = conn.execute("SELECT COUNT(*) AS c FROM memory_entries WHERE approved = 1").fetchone()["c"]
        total_knowledge_docs = conn.execute("SELECT COUNT(*) AS c FROM knowledge_documents").fetchone()["c"]
        total_knowledge_chunks = conn.execute("SELECT COUNT(*) AS c FROM knowledge_chunks").fetchone()["c"]
        total_conversations = conn.execute("SELECT COUNT(*) AS c FROM conversations").fetchone()["c"]
        total_messages = conn.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"]
        return {
            "total_memories": int(total_memories),
            "total_knowledge_docs": int(total_knowledge_docs),
            "total_knowledge_chunks": int(total_knowledge_chunks),
            "total_conversations": int(total_conversations),
            "total_messages": int(total_messages),
            "fts5_enabled": has_fts5_support(conn),
            "auto_save_disabled": True,
        }
    finally:
        conn.close()


@router.get("/memory")
def list_memory(
    namespace: str | None = None,
    category: str | None = None,
    q: str | None = None,
) -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM memory_entries ORDER BY updated_at DESC").fetchall()
        results: list[dict[str, object]] = []
        query_lower = (q or "").strip().lower()
        for r in rows:
            if namespace and namespace != "all" and r["namespace"] != namespace:
                continue
            row_category = r["category"] if "category" in r.keys() and r["category"] else "fact"
            if category and category != "all" and row_category != category:
                continue
            if query_lower and (
                query_lower not in r["title"].lower()
                and query_lower not in r["content"].lower()
                and query_lower not in r["tags_json"].lower()
            ):
                continue
            results.append(
                {
                    "id": r["id"],
                    "namespace": r["namespace"],
                    "category": row_category,
                    "title": r["title"],
                    "content": r["content"],
                    "tags": json.loads(r["tags_json"] or "[]"),
                    "importance": r["importance"],
                    "approved": bool(r["approved"] if "approved" in r.keys() else 1),
                    "source_conversation_id": r["source_conversation_id"] if "source_conversation_id" in r.keys() else None,
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                }
            )
        return results
    finally:
        conn.close()


@router.post("/memory", status_code=201)
def create_memory(payload: MemoryCreate) -> dict[str, object]:
    if not payload.approved:
        raise HTTPException(
            status_code=400,
            detail="Explicit user approval is required before storing personal memory.",
        )
    safe_title = payload.title.strip()
    safe_content = payload.content.strip()
    if not safe_title or not safe_content:
        raise HTTPException(status_code=400, detail="Title and content are required.")
    if len(safe_title) > 160 or len(safe_content) > 4000:
        raise HTTPException(
            status_code=400,
            detail="Memory title (max 160) or content (max 4000 chars) exceeds limit.",
        )
    secret_found = detect_sensitive_secret(f"{safe_title}\n{safe_content}")
    if secret_found:
        raise HTTPException(
            status_code=400,
            detail=f"Rejected for privacy: detected potential {secret_found}. Never store passwords, private keys, or API tokens in memory.",
        )

    safe_category = payload.category if payload.category in VALID_MEMORY_CATEGORIES else "fact"
    safe_tags = [str(t).strip() for t in payload.tags if str(t).strip()][:20]
    safe_tags_json = json.dumps(safe_tags)

    conn = get_connection()
    now = utc_now()
    mem_id = f"mem-{uuid.uuid4()}"
    fts = has_fts5_support(conn)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO memory_entries
                (id, namespace, category, title, content, tags_json, importance, approved, source_conversation_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                mem_id,
                payload.namespace,
                safe_category,
                safe_title,
                safe_content,
                safe_tags_json,
                payload.importance,
                payload.source_conversation_id,
                now,
                now,
            ),
        )
        if fts:
            conn.execute(
                "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
                (mem_id, safe_title, safe_content, " ".join(safe_tags)),
            )
        conn.commit()
        return {
            "id": mem_id,
            "namespace": payload.namespace,
            "category": safe_category,
            "title": safe_title,
            "content": safe_content,
            "tags": safe_tags,
            "importance": payload.importance,
            "approved": True,
            "source_conversation_id": payload.source_conversation_id,
            "created_at": now,
            "updated_at": now,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.put("/memory/{memory_id}")
def update_memory(memory_id: str, payload: MemoryUpdate) -> dict[str, object]:
    conn = get_connection()
    try:
        existing = conn.execute("SELECT * FROM memory_entries WHERE id = ?", (memory_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Memory entry not found.")

        next_title = (payload.title if payload.title is not None else existing["title"]).strip()
        next_content = (payload.content if payload.content is not None else existing["content"]).strip()
        if not next_title or not next_content:
            raise HTTPException(status_code=400, detail="Title and content cannot be empty.")
        if len(next_title) > 160 or len(next_content) > 4000:
            raise HTTPException(
                status_code=400,
                detail="Memory title (max 160) or content (max 4000 chars) exceeds limit.",
            )
        secret_found = detect_sensitive_secret(f"{next_title}\n{next_content}")
        if secret_found:
            raise HTTPException(
                status_code=400,
                detail=f"Rejected for privacy: detected potential {secret_found}. Never store passwords, private keys, or API tokens in memory.",
            )

        existing_cat = existing["category"] if "category" in existing.keys() and existing["category"] else "fact"
        next_category = (
            payload.category if payload.category in VALID_MEMORY_CATEGORIES else existing_cat
        )
        next_namespace = payload.namespace or existing["namespace"]
        existing_tags = json.loads(existing["tags_json"] or "[]")
        next_tags = (
            [str(t).strip() for t in payload.tags if str(t).strip()][:20]
            if payload.tags is not None
            else existing_tags
        )
        next_importance = (
            payload.importance if payload.importance is not None else int(existing["importance"])
        )
        now = utc_now()
        fts = has_fts5_support(conn)

        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            UPDATE memory_entries
            SET namespace = ?, category = ?, title = ?, content = ?, tags_json = ?, importance = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_namespace,
                next_category,
                next_title,
                next_content,
                json.dumps(next_tags),
                next_importance,
                now,
                memory_id,
            ),
        )
        if fts:
            conn.execute("DELETE FROM memory_entries_fts WHERE memory_id = ?", (memory_id,))
            conn.execute(
                "INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)",
                (memory_id, next_title, next_content, " ".join(next_tags)),
            )
        conn.commit()
        return {
            "id": memory_id,
            "namespace": next_namespace,
            "category": next_category,
            "title": next_title,
            "content": next_content,
            "tags": next_tags,
            "importance": next_importance,
            "approved": bool(existing["approved"] if "approved" in existing.keys() else 1),
            "source_conversation_id": existing["source_conversation_id"] if "source_conversation_id" in existing.keys() else None,
            "created_at": existing["created_at"],
            "updated_at": now,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.delete("/memory/{memory_id}")
def delete_memory(memory_id: str) -> dict[str, object]:
    conn = get_connection()
    fts = has_fts5_support(conn)
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute("DELETE FROM memory_entries WHERE id = ?", (memory_id,))
        if fts:
            conn.execute("DELETE FROM memory_entries_fts WHERE memory_id = ?", (memory_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Memory entry not found.")
        return {"deleted": True, "id": memory_id}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.get("/knowledge")
def list_knowledge(source_type: str | None = None, q: str | None = None) -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM knowledge_documents ORDER BY updated_at DESC").fetchall()
        query_lower = (q or "").strip().lower()
        results: list[dict[str, object]] = []
        for r in rows:
            if source_type and source_type != "all" and r["source_type"] != source_type:
                continue
            if query_lower and (
                query_lower not in r["title"].lower()
                and query_lower not in r["content"].lower()
                and query_lower not in r["tags_json"].lower()
            ):
                continue
            results.append(
                {
                    "id": r["id"],
                    "title": r["title"],
                    "source_type": r["source_type"],
                    "source_name": r["source_name"],
                    "content": r["content"],
                    "tags": json.loads(r["tags_json"] or "[]"),
                    "chunk_count": int(r["chunk_count"]),
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                }
            )
        return results
    finally:
        conn.close()


@router.get("/knowledge/{doc_id}")
def get_knowledge_document(doc_id: str) -> dict[str, object]:
    conn = get_connection()
    try:
        doc = conn.execute("SELECT * FROM knowledge_documents WHERE id = ?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Knowledge document not found.")
        chunks = conn.execute(
            "SELECT id, document_id, chunk_index, content, token_estimate, created_at FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC",
            (doc_id,),
        ).fetchall()
        return {
            "id": doc["id"],
            "title": doc["title"],
            "source_type": doc["source_type"],
            "source_name": doc["source_name"],
            "content": doc["content"],
            "tags": json.loads(doc["tags_json"] or "[]"),
            "chunk_count": int(doc["chunk_count"]),
            "created_at": doc["created_at"],
            "updated_at": doc["updated_at"],
            "chunks": [dict(c) for c in chunks],
        }
    finally:
        conn.close()


@router.post("/knowledge", status_code=201)
def create_knowledge_document(payload: KnowledgeDocumentCreate) -> dict[str, object]:
    safe_title = payload.title.strip()
    safe_content = payload.content.strip()
    if not safe_title or not safe_content:
        raise HTTPException(status_code=400, detail="Document title and content are required.")
    if len(safe_title) > 200 or len(safe_content) > 100000:
        raise HTTPException(
            status_code=400,
            detail="Knowledge document exceeds maximum size (100,000 chars).",
        )
    secret_found = detect_sensitive_secret(f"{safe_title}\n{safe_content}")
    if secret_found:
        raise HTTPException(
            status_code=400,
            detail=f"Rejected for privacy: detected potential {secret_found}. Remove credentials before indexing documents.",
        )

    safe_tags = [str(t).strip() for t in payload.tags if str(t).strip()][:20]
    safe_source_type = payload.source_type.strip() or "note"
    safe_source_name = payload.source_name.strip()
    chunks = chunk_knowledge_text(safe_content)

    conn = get_connection()
    now = utc_now()
    doc_id = f"kdoc-{uuid.uuid4()}"
    fts = has_fts5_support(conn)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO knowledge_documents
                (id, title, source_type, source_name, content, tags_json, char_count, chunk_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                doc_id,
                safe_title,
                safe_source_type,
                safe_source_name,
                safe_content,
                json.dumps(safe_tags),
                len(safe_content),
                len(chunks),
                now,
                now,
            ),
        )
        for ch in chunks:
            chunk_id = f"kchk-{uuid.uuid4()}"
            conn.execute(
                """
                INSERT INTO knowledge_chunks
                    (id, document_id, chunk_index, content, token_estimate, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (chunk_id, doc_id, ch["chunk_index"], ch["content"], ch["token_estimate"], now),
            )
            if fts:
                conn.execute(
                    "INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)",
                    (chunk_id, doc_id, safe_title, ch["content"], " ".join(safe_tags)),
                )
        conn.commit()
        return {
            "id": doc_id,
            "title": safe_title,
            "source_type": safe_source_type,
            "source_name": safe_source_name,
            "content": safe_content,
            "tags": safe_tags,
            "chunk_count": len(chunks),
            "created_at": now,
            "updated_at": now,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.put("/knowledge/{doc_id}")
def update_knowledge_document(doc_id: str, payload: KnowledgeDocumentUpdate) -> dict[str, object]:
    conn = get_connection()
    try:
        existing = conn.execute("SELECT * FROM knowledge_documents WHERE id = ?", (doc_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Knowledge document not found.")

        next_title = (payload.title if payload.title is not None else existing["title"]).strip()
        next_content = (payload.content if payload.content is not None else existing["content"]).strip()
        if not next_title or not next_content:
            raise HTTPException(status_code=400, detail="Document title and content cannot be empty.")
        if len(next_title) > 200 or len(next_content) > 100000:
            raise HTTPException(
                status_code=400,
                detail="Knowledge document exceeds maximum size (100,000 chars).",
            )
        secret_found = detect_sensitive_secret(f"{next_title}\n{next_content}")
        if secret_found:
            raise HTTPException(
                status_code=400,
                detail=f"Rejected for privacy: detected potential {secret_found}. Remove credentials before indexing documents.",
            )

        next_source_type = (payload.source_type if payload.source_type is not None else existing["source_type"]) or "note"
        next_source_name = (
            payload.source_name.strip() if payload.source_name is not None else existing["source_name"]
        )
        existing_tags = json.loads(existing["tags_json"] or "[]")
        next_tags = (
            [str(t).strip() for t in payload.tags if str(t).strip()][:20]
            if payload.tags is not None
            else existing_tags
        )
        chunks = chunk_knowledge_text(next_content)
        now = utc_now()
        fts = has_fts5_support(conn)

        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            UPDATE knowledge_documents
            SET title = ?, source_type = ?, source_name = ?, content = ?, tags_json = ?, char_count = ?, chunk_count = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_title,
                next_source_type,
                next_source_name,
                next_content,
                json.dumps(next_tags),
                len(next_content),
                len(chunks),
                now,
                doc_id,
            ),
        )
        conn.execute("DELETE FROM knowledge_chunks WHERE document_id = ?", (doc_id,))
        if fts:
            conn.execute("DELETE FROM knowledge_chunks_fts WHERE document_id = ?", (doc_id,))
        for ch in chunks:
            chunk_id = f"kchk-{uuid.uuid4()}"
            conn.execute(
                """
                INSERT INTO knowledge_chunks
                    (id, document_id, chunk_index, content, token_estimate, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (chunk_id, doc_id, ch["chunk_index"], ch["content"], ch["token_estimate"], now),
            )
            if fts:
                conn.execute(
                    "INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)",
                    (chunk_id, doc_id, next_title, ch["content"], " ".join(next_tags)),
                )
        conn.commit()
        return {
            "id": doc_id,
            "title": next_title,
            "source_type": next_source_type,
            "source_name": next_source_name,
            "content": next_content,
            "tags": next_tags,
            "chunk_count": len(chunks),
            "created_at": existing["created_at"],
            "updated_at": now,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.delete("/knowledge/{doc_id}")
def delete_knowledge_document(doc_id: str) -> dict[str, object]:
    conn = get_connection()
    fts = has_fts5_support(conn)
    try:
        conn.execute("BEGIN IMMEDIATE")
        if fts:
            conn.execute("DELETE FROM knowledge_chunks_fts WHERE document_id = ?", (doc_id,))
        conn.execute("DELETE FROM knowledge_chunks WHERE document_id = ?", (doc_id,))
        cur = conn.execute("DELETE FROM knowledge_documents WHERE id = ?", (doc_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Knowledge document not found.")
        return {"deleted": True, "id": doc_id}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.post("/retrieval/query")
def query_retrieval_endpoint(payload: RetrievalQueryPayload) -> dict[str, object]:
    conn = get_connection()
    try:
        retriever = SqliteKeywordRetriever(conn)
        result = retriever.retrieve(
            payload.query,
            include_memory=payload.include_memory,
            include_knowledge=payload.include_knowledge,
            max_memory_items=payload.max_memory_items,
            max_knowledge_chunks=payload.max_knowledge_chunks,
        )
        return {
            **result,
            "formatted_context": format_retrieved_system_context(result),
        }
    finally:
        conn.close()

