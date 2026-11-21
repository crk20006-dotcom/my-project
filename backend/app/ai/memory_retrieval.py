"""
Modular Memory & Knowledge Retrieval Engine for Project Genesis (Python FastAPI).

Supports SQLite FTS5 keyword retrieval (with safe LIKE fallback) across two strictly
separated stores:
1. Approved User Memory (`memory_entries`)
2. User-provided Knowledge Base (`knowledge_documents` / `knowledge_chunks`)

Designed around an abstract `BaseKnowledgeRetriever` contract so future local
embedding / vector-hybrid retrievers can plug in without modifying chat routes.
"""

from __future__ import annotations

import re
import sqlite3
from abc import ABC, abstractmethod
from typing import Any

from app.ai.tokenizer import BaselineTokenizer


def has_fts5_support(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT 1 FROM memory_entries_fts LIMIT 1").fetchone()
        conn.execute("SELECT 1 FROM knowledge_chunks_fts LIMIT 1").fetchone()
        return True
    except sqlite3.Error:
        return False


_tokenizer = BaselineTokenizer()

STOP_WORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "what",
    "when",
    "where",
    "which",
    "about",
    "into",
    "your",
    "have",
    "does",
    "how",
    "are",
    "was",
    "were",
    "can",
    "you",
    "use",
}


def chunk_knowledge_text(
    raw_content: str,
    chunk_size: int = 600,
    overlap: int = 80,
    max_chunks: int = 80,
) -> list[dict[str, Any]]:
    normalized = raw_content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    chunks: list[dict[str, Any]] = []
    cursor = 0
    index = 0
    n = len(normalized)

    while cursor < n and len(chunks) < max_chunks:
        end = min(n, cursor + chunk_size)
        if end < n:
            window = normalized[cursor:end]
            last_para = window.rfind("\n\n")
            last_line = window.rfind("\n")
            last_space = window.rfind(" ")
            if last_para > chunk_size * 0.45:
                end = cursor + last_para
            elif last_line > chunk_size * 0.55:
                end = cursor + last_line
            elif last_space > chunk_size * 0.65:
                end = cursor + last_space

        part = normalized[cursor:end].strip()
        if part:
            chunks.append(
                {
                    "chunk_index": index,
                    "content": part,
                    "token_estimate": _tokenizer.inspect(part)["token_count"],
                }
            )
            index += 1

        if end >= n:
            break
        cursor = max(cursor + 1, end - overlap)

    return chunks


def extract_query_terms(query: str) -> list[str]:
    matches = re.findall(r"[a-z0-9_]{2,}", (query or "").lower())
    unique: list[str] = []
    seen: set[str] = set()
    for term in matches:
        if term not in seen:
            seen.add(term)
            unique.append(term)
    meaningful = [t for t in unique if t not in STOP_WORDS]
    return (meaningful if meaningful else unique)[:10]


def _build_fts_expr(terms: list[str]) -> str:
    return " OR ".join(f'"{t.replace(chr(34), "")}"' for t in terms)


class BaseKnowledgeRetriever(ABC):
    """Interface allowing drop-in replacement with future local vector/embedding retrievers."""

    @abstractmethod
    def retrieve(
        self,
        query: str,
        include_memory: bool = True,
        include_knowledge: bool = True,
        max_memory_items: int = 3,
        max_knowledge_chunks: int = 3,
        context_length: int = 8192,
    ) -> dict[str, Any]: ...


class SqliteKeywordRetriever(BaseKnowledgeRetriever):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def retrieve(
        self,
        query: str,
        include_memory: bool = True,
        include_knowledge: bool = True,
        max_memory_items: int = 3,
        max_knowledge_chunks: int = 3,
        context_length: int = 8192,
    ) -> dict[str, Any]:
        trimmed = (query or "").strip()
        fts_available = has_fts5_support(self.conn)
        backend = "sqlite_fts5" if fts_available else "sqlite_like"

        if not trimmed or (not include_memory and not include_knowledge):
            return {
                "queried": False,
                "query": trimmed,
                "retrieval_backend": backend,
                "memories": [],
                "knowledge": [],
                "total_context_tokens": 0,
            }

        terms = extract_query_terms(trimmed)
        if not terms:
            return {
                "queried": True,
                "query": trimmed,
                "retrieval_backend": backend,
                "memories": [],
                "knowledge": [],
                "total_context_tokens": 0,
            }

        safe_ctx = max(128, context_length)
        token_budget = min(480, max(120, int(safe_ctx * 0.2)))
        memory_budget = int(token_budget * 0.45) if include_knowledge else token_budget
        used_tokens = 0
        memories: list[dict[str, Any]] = []
        knowledge: list[dict[str, Any]] = []
        match_expr = _build_fts_expr(terms)

        if include_memory and max_memory_items > 0:
            rows = []
            if fts_available and match_expr:
                try:
                    rows = self.conn.execute(
                        """
                        SELECT m.id, m.namespace, m.category, m.title, m.content, m.importance,
                               (-bm25(memory_entries_fts) + (m.importance * 0.15)) AS score
                        FROM memory_entries_fts f
                        JOIN memory_entries m ON m.id = f.memory_id
                        WHERE memory_entries_fts MATCH ? AND m.approved = 1
                        ORDER BY score DESC
                        LIMIT ?
                        """,
                        (match_expr, max_memory_items),
                    ).fetchall()
                except sqlite3.Error:
                    rows = []

            if not rows and not fts_available:
                clauses = " OR ".join(
                    "(LOWER(title) LIKE ? OR LOWER(content) LIKE ? OR LOWER(tags_json) LIKE ?)"
                    for _ in terms
                )
                params: list[Any] = []
                for t in terms:
                    pat = f"%{t}%"
                    params.extend([pat, pat, pat])
                params.append(max_memory_items)
                rows = self.conn.execute(
                    f"""
                    SELECT id, namespace, category, title, content, importance,
                           (importance * 0.25) AS score
                    FROM memory_entries
                    WHERE approved = 1 AND ({clauses})
                    ORDER BY importance DESC, updated_at DESC
                    LIMIT ?
                    """,
                    params,
                ).fetchall()

            for r in rows:
                snippet = str(r["content"])[:320]
                est = _tokenizer.inspect(f"{r['title']}: {snippet}", safe_ctx)["token_count"] + 6
                if used_tokens + est > memory_budget and memories:
                    break
                if used_tokens + est > token_budget and memories:
                    break
                used_tokens += est
                memories.append(
                    {
                        "id": r["id"],
                        "namespace": r["namespace"],
                        "category": r["category"] or "fact",
                        "title": r["title"],
                        "content": snippet,
                        "importance": int(r["importance"]),
                        "score": round(float(r["score"] or 0.0), 3),
                    }
                )

        if include_knowledge and max_knowledge_chunks > 0:
            rows = []
            if fts_available and match_expr:
                try:
                    rows = self.conn.execute(
                        """
                        SELECT c.id AS chunk_id, c.document_id, d.title AS document_title,
                               d.source_type, c.chunk_index, c.content,
                               (-bm25(knowledge_chunks_fts)) AS score
                        FROM knowledge_chunks_fts f
                        JOIN knowledge_chunks c ON c.id = f.chunk_id
                        JOIN knowledge_documents d ON d.id = c.document_id
                        WHERE knowledge_chunks_fts MATCH ?
                        ORDER BY score DESC
                        LIMIT ?
                        """,
                        (match_expr, max_knowledge_chunks),
                    ).fetchall()
                except sqlite3.Error:
                    rows = []

            if not rows and not fts_available:
                clauses = " OR ".join(
                    "(LOWER(d.title) LIKE ? OR LOWER(c.content) LIKE ? OR LOWER(d.tags_json) LIKE ?)"
                    for _ in terms
                )
                params = []
                for t in terms:
                    pat = f"%{t}%"
                    params.extend([pat, pat, pat])
                params.append(max_knowledge_chunks)
                rows = self.conn.execute(
                    f"""
                    SELECT c.id AS chunk_id, c.document_id, d.title AS document_title,
                           d.source_type, c.chunk_index, c.content, 1.0 AS score
                    FROM knowledge_chunks c
                    JOIN knowledge_documents d ON d.id = c.document_id
                    WHERE ({clauses})
                    ORDER BY d.updated_at DESC, c.chunk_index ASC
                    LIMIT ?
                    """,
                    params,
                ).fetchall()

            for r in rows:
                snippet = str(r["content"])[:480]
                est = (
                    _tokenizer.inspect(f"{r['document_title']}: {snippet}", safe_ctx)["token_count"]
                    + 8
                )
                if used_tokens + est > token_budget:
                    if not knowledge and (token_budget - used_tokens) >= 40:
                        avail_tokens = max(24, token_budget - used_tokens - 12)
                        snippet = snippet[: avail_tokens * 3]
                        est = (
                            _tokenizer.inspect(
                                f"{r['document_title']}: {snippet}", safe_ctx
                            )["token_count"]
                            + 8
                        )
                    else:
                        break
                used_tokens += est
                knowledge.append(
                    {
                        "chunk_id": r["chunk_id"],
                        "document_id": r["document_id"],
                        "document_title": r["document_title"],
                        "source_type": r["source_type"] or "note",
                        "chunk_index": int(r["chunk_index"]),
                        "content": snippet,
                        "score": round(float(r["score"] or 0.0), 3),
                    }
                )

        return {
            "queried": True,
            "query": trimmed,
            "retrieval_backend": backend,
            "memories": memories,
            "knowledge": knowledge,
            "total_context_tokens": used_tokens,
        }


def format_retrieved_system_context(retrieval: dict[str, Any]) -> str | None:
    memories = retrieval.get("memories") or []
    knowledge = retrieval.get("knowledge") or []
    if not memories and not knowledge:
        return None

    lines = [
        "Use the following verified local User Memory and Knowledge Base excerpts only when relevant. "
        "Do not invent facts beyond what is explicitly provided."
    ]
    if memories:
        lines.extend(["", "[Approved User Memory]"])
        for m in memories:
            lines.append(f"- ({m['category']}/{m['namespace']}) {m['title']}: {m['content']}")
    if knowledge:
        lines.extend(["", "[Knowledge Base Excerpts]"])
        for k in knowledge:
            lines.append(f"- ({k['document_title']} #chunk-{k['chunk_index']}): {k['content']}")
    return "\n".join(lines)


def search_conversation_history(
    conn: sqlite3.Connection,
    query: str,
    limit: int = 20,
) -> list[dict[str, Any]]:
    trimmed = (query or "").strip()
    if not trimmed:
        return []
    pat = f"%{trimmed.lower()}%"
    rows = conn.execute(
        """
        SELECT m.id AS message_id, m.conversation_id, c.title AS conversation_title,
               m.role, m.content, m.created_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE LOWER(m.content) LIKE ? OR LOWER(c.title) LIKE ?
        ORDER BY m.created_at DESC
        LIMIT ?
        """,
        (pat, pat, min(50, max(1, limit))),
    ).fetchall()
    return [
        {
            "message_id": r["message_id"],
            "conversation_id": r["conversation_id"],
            "conversation_title": r["conversation_title"],
            "role": r["role"],
            "snippet": str(r["content"])[:260],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
