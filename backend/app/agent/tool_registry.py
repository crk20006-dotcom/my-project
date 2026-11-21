import ast
import hashlib
import json
import math
import os
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from app.ai.memory_retrieval import SqliteKeywordRetriever, has_fts5_support
from app.ai.tokenizer import BaselineTokenizer
from app.core.security import detect_sensitive_secret

MAX_READ_BYTES = 64 * 1024
MAX_DOC_CHARS = 50_000
MAX_CODE_CHARS = 2_500

_SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "math": math,
    "json": json,
}

_FORBIDDEN_NAMES = {
    "__import__",
    "__builtins__",
    "__class__",
    "__subclasses__",
    "__globals__",
    "__code__",
    "open",
    "eval",
    "exec",
    "compile",
    "input",
    "globals",
    "locals",
    "vars",
    "dir",
    "getattr",
    "setattr",
    "delattr",
    "os",
    "sys",
    "subprocess",
    "pathlib",
    "socket",
}


def get_approved_workspace_dir(custom_root: str | Path | None = None) -> Path:
    root = Path(custom_root).resolve() if custom_root else (Path.cwd() / "data" / "agent_workspace").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_safe_workspace_path(
    requested_path: str,
    *,
    allow_docs_folder: bool = False,
    custom_root: str | Path | None = None,
    require_subdir: str | None = None,
) -> tuple[bool, Path | None, str, str]:
    cleaned = (requested_path or "").strip()
    if not cleaned:
        return False, None, "", "File path is required."
    if "\x00" in cleaned or Path(cleaned).is_absolute():
        return False, None, "", "Absolute paths and null bytes are blocked by sandbox policy."

    normalized = cleaned.replace("\\", "/").lstrip("./")
    lower = normalized.lower()
    if ".." in lower or lower.endswith(".db") or ".db-" in lower or lower.startswith(".env") or "/.env" in lower:
        return False, None, "", "Path traversal, database files, and environment files are blocked."

    workspace_root = get_approved_workspace_dir(custom_root)
    docs_root = (Path.cwd() / "docs").resolve()

    if allow_docs_folder and (lower == "docs" or lower.startswith("docs/")):
        rel = normalized[5:]
        target = (docs_root / rel).resolve()
        try:
            rel_path = target.relative_to(docs_root)
        except ValueError:
            return False, None, "", "Resolved path escapes approved docs directory."
        return True, target, f"docs/{rel_path.as_posix()}", ""

    sub_root = (workspace_root / require_subdir).resolve() if require_subdir else workspace_root
    sub_root.mkdir(parents=True, exist_ok=True)

    stripped = normalized
    for prefix in ("data/agent_workspace/", "agent_workspace/"):
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix) :]
            break

    target = (sub_root / stripped).resolve()
    try:
        rel_path = target.relative_to(sub_root)
    except ValueError:
        return False, None, "", "Path must resolve strictly inside approved agent workspace."
    if str(rel_path) in {"", "."}:
        return False, None, "", "Path must target a file inside approved agent workspace."

    display = (
        f"data/agent_workspace/{require_subdir}/{rel_path.as_posix()}"
        if require_subdir
        else f"data/agent_workspace/{rel_path.as_posix()}"
    )
    return True, target, display, ""


def _sanitize_doc_filename(raw_name: str) -> str:
    base = Path((raw_name or "agent_report.md").strip()).name
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", base).lstrip(".")
    if not safe:
        return "agent_report.md"
    ext = Path(safe).suffix.lower()
    if ext not in {".md", ".txt", ".json", ".csv"}:
        return f"{safe}.md"
    return safe


def _validate_restricted_ast(tree: ast.AST) -> str | None:
    allowed_nodes = (
        ast.Module,
        ast.Expr,
        ast.Assign,
        ast.AugAssign,
        ast.AnnAssign,
        ast.Constant,
        ast.Name,
        ast.Load,
        ast.Store,
        ast.BinOp,
        ast.UnaryOp,
        ast.BoolOp,
        ast.Compare,
        ast.IfExp,
        ast.If,
        ast.For,
        ast.List,
        ast.Tuple,
        ast.Dict,
        ast.Set,
        ast.ListComp,
        ast.DictComp,
        ast.comprehension,
        ast.Subscript,
        ast.Slice,
        ast.Call,
        ast.Attribute,
        ast.JoinedStr,
        ast.FormattedValue,
        ast.Add,
        ast.Sub,
        ast.Mult,
        ast.Div,
        ast.FloorDiv,
        ast.Mod,
        ast.Pow,
        ast.USub,
        ast.UAdd,
        ast.Not,
        ast.And,
        ast.Or,
        ast.Eq,
        ast.NotEq,
        ast.Lt,
        ast.LtE,
        ast.Gt,
        ast.GtE,
        ast.In,
        ast.NotIn,
        ast.Return,
    )
    for node in ast.walk(tree):
        if not isinstance(node, allowed_nodes):
            return f"Disallowed syntax construct: {type(node).__name__}"
        if isinstance(node, ast.Name) and node.id in _FORBIDDEN_NAMES:
            return f"Forbidden identifier: {node.id}"
        if isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr in _FORBIDDEN_NAMES):
            return f"Forbidden attribute access: {node.attr}"
    return None


@dataclass
class AgentToolContext:
    conn: sqlite3.Connection
    agent_id: str
    task_id: str
    workspace_root: str | None = None


@dataclass
class AgentToolResult:
    ok: bool
    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    retryable: bool = False


@dataclass
class AgentToolDefinition:
    id: str
    name: str
    category: str
    description: str
    risk_level: str
    requires_approval: bool
    safe_retryable: bool
    operational: bool
    input_schema: dict[str, Any]
    execute: Callable[[dict[str, Any], AgentToolContext], AgentToolResult]


class AgentToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, AgentToolDefinition] = {}
        self._tokenizer = BaselineTokenizer()
        self._register_defaults()

    def register(self, definition: AgentToolDefinition) -> None:
        self._tools[definition.id] = definition

    def get(self, tool_id: str) -> AgentToolDefinition | None:
        return self._tools.get(tool_id)

    def list_descriptors(self) -> list[dict[str, Any]]:
        return [
            {
                "id": t.id,
                "name": t.name,
                "category": t.category,
                "description": t.description,
                "risk_level": t.risk_level,
                "requires_approval": t.requires_approval,
                "safe_retryable": t.safe_retryable,
                "operational": t.operational,
                "input_schema": t.input_schema,
            }
            for t in self._tools.values()
        ]

    def get_operational_tool_ids(self) -> list[str]:
        return [t.id for t in self._tools.values() if t.operational]

    def invoke(
        self,
        tool_id: str,
        tool_input: dict[str, Any],
        allowed_tools: list[str],
        ctx: AgentToolContext,
    ) -> AgentToolResult:
        definition = self._tools.get(tool_id)
        if not definition:
            return AgentToolResult(
                ok=False,
                summary=f"Unknown tool '{tool_id}'.",
                error=f"Tool '{tool_id}' is not registered in AgentToolRegistry.",
            )
        if not definition.operational:
            return AgentToolResult(
                ok=False,
                summary=f"Tool '{tool_id}' is a reserved future extension interface and is not operational yet.",
                data={"operational": False, "status": "interface_reserved"},
                error=f"Tool '{tool_id}' is not operational in Step 07.",
            )
        if tool_id not in allowed_tools:
            return AgentToolResult(
                ok=False,
                summary=f"Tool '{tool_id}' denied by agent allowlist.",
                error=f"Permission denied: '{tool_id}' is not enabled on agent '{ctx.agent_id}'.",
            )
        try:
            result = definition.execute(tool_input or {}, ctx)
            secret_hit = detect_sensitive_secret(json.dumps(result.data))
            if secret_hit:
                return AgentToolResult(
                    ok=False,
                    summary="Tool output redacted by privacy guard.",
                    error=f"Tool output blocked: potential {secret_hit} detected.",
                )
            return result
        except Exception as exc:
            return AgentToolResult(
                ok=False,
                summary=f"Tool '{tool_id}' failed during execution.",
                error=str(exc),
                retryable=definition.safe_retryable,
            )

    def _register_defaults(self) -> None:
        def exec_read_file(inp: dict[str, Any], ctx: AgentToolContext) -> AgentToolResult:
            req_path = str(inp.get("path") or "workspace_readme.txt").strip()
            ok, resolved, display, err = resolve_safe_workspace_path(
                req_path, allow_docs_folder=True, custom_root=ctx.workspace_root
            )
            if not ok or resolved is None:
                return AgentToolResult(ok=False, summary="File access denied by sandbox.", error=err)
            if not resolved.exists() or not resolved.is_file():
                return AgentToolResult(
                    ok=False,
                    summary=f"File not found: {display}",
                    data={"path": display},
                    error=f"File does not exist at {display}.",
                )
            size = resolved.stat().st_size
            if size > MAX_READ_BYTES:
                return AgentToolResult(
                    ok=False,
                    summary="File exceeds 64 KB sandbox read cap.",
                    data={"size_bytes": size},
                    error="File exceeds 64 KB sandbox read cap.",
                )
            content = resolved.read_text(encoding="utf-8")
            secret_hit = detect_sensitive_secret(content)
            if secret_hit:
                return AgentToolResult(
                    ok=False,
                    summary="File blocked by privacy scanner.",
                    data={"path": display},
                    error=f"Blocked reading {display}: potential {secret_hit} found.",
                )
            max_preview = min(2000, max(120, int(inp.get("max_preview_chars", 1200))))
            return AgentToolResult(
                ok=True,
                summary=f"Read {display} ({len(content.splitlines())} lines, {size} bytes).",
                data={
                    "path": display,
                    "size_bytes": size,
                    "line_count": len(content.splitlines()),
                    "token_estimate": self._tokenizer.inspect(content)["token_count"],
                    "sha256_prefix": hashlib.sha256(content.encode("utf-8")).hexdigest()[:16],
                    "preview": content[:max_preview],
                },
            )

        def exec_create_doc(inp: dict[str, Any], ctx: AgentToolContext) -> AgentToolResult:
            safe_name = _sanitize_doc_filename(str(inp.get("filename") or "agent_output.md"))
            content = str(inp.get("content") or "").strip()
            title = str(inp.get("title") or safe_name).strip()
            if not content:
                return AgentToolResult(ok=False, summary="Document content cannot be empty.", error="Empty document content.")
            if len(content) > MAX_DOC_CHARS:
                return AgentToolResult(ok=False, summary="Document exceeds 50,000 character cap.", error="Document too large.")
            secret_hit = detect_sensitive_secret(f"{title}\n{content}")
            if secret_hit:
                return AgentToolResult(
                    ok=False,
                    summary="Document creation blocked by secret scanner.",
                    error=f"Potential {secret_hit} detected; refusing to write document.",
                )
            ok, resolved, display, err = resolve_safe_workspace_path(
                safe_name, custom_root=ctx.workspace_root, require_subdir="documents"
            )
            if not ok or resolved is None:
                return AgentToolResult(ok=False, summary="Document path rejected.", error=err)
            resolved.write_text(content, encoding="utf-8")
            raw_bytes = len(content.encode("utf-8"))
            return AgentToolResult(
                ok=True,
                summary=f"Created approved document {display} ({raw_bytes} bytes).",
                data={
                    "path": display,
                    "filename": safe_name,
                    "title": title,
                    "bytes": raw_bytes,
                    "sha256_prefix": hashlib.sha256(content.encode("utf-8")).hexdigest()[:16],
                },
            )

        def exec_restricted_code(inp: dict[str, Any], _ctx: AgentToolContext) -> AgentToolResult:
            code = str(inp.get("code") or "").strip()
            if not code:
                return AgentToolResult(ok=False, summary="No code supplied.", error="Code input is required.")
            if len(code) > MAX_CODE_CHARS:
                return AgentToolResult(ok=False, summary="Code exceeds 2,500 character limit.", error="Code too long.")
            try:
                tree = ast.parse(code, mode="exec")
            except SyntaxError as exc:
                return AgentToolResult(ok=False, summary="Syntax error in restricted script.", error=str(exc))
            violation = _validate_restricted_ast(tree)
            if violation:
                return AgentToolResult(
                    ok=False,
                    summary="Restricted sandbox blocked unsafe construct.",
                    error=violation,
                )
            logs: list[str] = []

            def safe_print(*args: Any) -> None:
                if len(logs) < 25:
                    logs.append(" ".join(str(a) for a in args)[:400])

            env_globals: dict[str, Any] = {"__builtins__": _SAFE_BUILTINS, "print": safe_print}
            env_locals: dict[str, Any] = {}
            try:
                exec(compile(tree, "<genesis_restricted>", "exec"), env_globals, env_locals)  # noqa: S102
                result_val = env_locals.get("result", "")
                return AgentToolResult(
                    ok=True,
                    summary=f"Restricted Python sandbox executed cleanly ({len(logs)} log line(s)).",
                    data={
                        "stdout": logs,
                        "result": str(result_val)[:2000],
                        "sandbox_mode": "ast_restricted_no_io",
                    },
                )
            except Exception as exc:
                return AgentToolResult(
                    ok=False,
                    summary="Restricted code execution raised an error.",
                    data={"stdout": logs},
                    error=str(exc),
                )

        def exec_retrieve_knowledge(inp: dict[str, Any], ctx: AgentToolContext) -> AgentToolResult:
            query = str(inp.get("query") or "").strip()
            if not query:
                return AgentToolResult(ok=False, summary="Query cannot be empty.", error="Query is required.")
            retriever = SqliteKeywordRetriever(ctx.conn)
            res = retriever.retrieve(
                query,
                include_memory=False,
                include_knowledge=True,
                max_knowledge_chunks=min(5, max(1, int(inp.get("max_chunks", 3)))),
                context_length=8192,
            )
            return AgentToolResult(
                ok=True,
                summary=f"Found {len(res['knowledge'])} matching Knowledge Base chunk(s) ({res['retrieval_backend']}).",
                data={
                    "backend": res["retrieval_backend"],
                    "matches": res["knowledge"],
                    "total_context_tokens": res["total_context_tokens"],
                },
            )

        def exec_retrieve_memory(inp: dict[str, Any], ctx: AgentToolContext) -> AgentToolResult:
            query = str(inp.get("query") or "").strip()
            if not query:
                return AgentToolResult(ok=False, summary="Query cannot be empty.", error="Query is required.")
            retriever = SqliteKeywordRetriever(ctx.conn)
            res = retriever.retrieve(
                query,
                include_memory=True,
                include_knowledge=False,
                max_memory_items=min(5, max(1, int(inp.get("max_items", 3)))),
                context_length=8192,
            )
            return AgentToolResult(
                ok=True,
                summary=f"Retrieved {len(res['memories'])} approved memory entry(ies) ({res['retrieval_backend']}).",
                data={
                    "backend": res["retrieval_backend"],
                    "matches": res["memories"],
                    "total_context_tokens": res["total_context_tokens"],
                },
            )

        def exec_local_ops(inp: dict[str, Any], ctx: AgentToolContext) -> AgentToolResult:
            op = str(inp.get("operation") or "summary")
            root = get_approved_workspace_dir(ctx.workspace_root)
            if op == "list_workspace_files":
                files = [
                    {"path": p.relative_to(root).as_posix(), "size_bytes": p.stat().st_size}
                    for p in sorted(root.rglob("*"))
                    if p.is_file()
                ][:40]
                return AgentToolResult(
                    ok=True,
                    summary=f"Listed {len(files)} file(s) inside ./data/agent_workspace.",
                    data={"workspace_root": "data/agent_workspace", "files": files},
                )
            if op == "list_models":
                models = [
                    dict(r)
                    for r in ctx.conn.execute(
                        "SELECT id, name, provider, status, loading_status, context_length FROM models ORDER BY created_at ASC"
                    ).fetchall()
                ]
                return AgentToolResult(
                    ok=True,
                    summary=f"Enumerated {len(models)} local model manifest(s).",
                    data={"models": models},
                )
            if op == "memory_status":
                mem_c = ctx.conn.execute("SELECT COUNT(*) FROM memory_entries WHERE approved = 1").fetchone()[0]
                doc_c = ctx.conn.execute("SELECT COUNT(*) FROM knowledge_documents").fetchone()[0]
                chk_c = ctx.conn.execute("SELECT COUNT(*) FROM knowledge_chunks").fetchone()[0]
                return AgentToolResult(
                    ok=True,
                    summary=f"Memory status: {mem_c} memories, {doc_c} docs, {chk_c} chunks.",
                    data={
                        "approved_memories": mem_c,
                        "knowledge_documents": doc_c,
                        "knowledge_chunks": chk_c,
                        "fts5_enabled": has_fts5_support(ctx.conn),
                    },
                )
            if op == "tokenize":
                tok = self._tokenizer.inspect(str(inp.get("text") or ""))
                return AgentToolResult(
                    ok=True,
                    summary=f"Tokenized input into {tok['token_count']} baseline token(s).",
                    data=tok,
                )
            mem_c = ctx.conn.execute("SELECT COUNT(*) FROM memory_entries WHERE approved = 1").fetchone()[0]
            doc_c = ctx.conn.execute("SELECT COUNT(*) FROM knowledge_documents").fetchone()[0]
            conv_c = ctx.conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
            return AgentToolResult(
                ok=True,
                summary=f"Local workspace healthy ({mem_c} memories, {doc_c} KB docs).",
                data={
                    "conversations": conv_c,
                    "approved_memories": mem_c,
                    "knowledge_documents": doc_c,
                },
            )

        self.register(
            AgentToolDefinition(
                id="read_workspace_file",
                name="Read & Process Workspace File",
                category="file_system",
                description="Reads UTF-8 files strictly inside ./data/agent_workspace or ./docs (max 64 KB).",
                risk_level="read_only",
                requires_approval=False,
                safe_retryable=True,
                operational=True,
                input_schema={"type": "object", "required": ["path"]},
                execute=exec_read_file,
            )
        )
        self.register(
            AgentToolDefinition(
                id="create_document",
                name="Create Workspace Document",
                category="document",
                description="Creates validated documents in ./data/agent_workspace/documents after operator approval.",
                risk_level="consequential",
                requires_approval=True,
                safe_retryable=False,
                operational=True,
                input_schema={"type": "object", "required": ["filename", "content"]},
                execute=exec_create_doc,
            )
        )
        self.register(
            AgentToolDefinition(
                id="run_restricted_code",
                name="Restricted Expression & Script Sandbox",
                category="code_execution",
                description="Executes pure AST-validated Python expressions without filesystem/network/subprocess access after approval.",
                risk_level="consequential",
                requires_approval=True,
                safe_retryable=False,
                operational=True,
                input_schema={"type": "object", "required": ["code"]},
                execute=exec_restricted_code,
            )
        )
        self.register(
            AgentToolDefinition(
                id="retrieve_knowledge",
                name="Knowledge Base Retrieval",
                category="knowledge",
                description="Searches indexed Knowledge Base chunks via SQLite FTS5 / LIKE.",
                risk_level="read_only",
                requires_approval=False,
                safe_retryable=True,
                operational=True,
                input_schema={"type": "object", "required": ["query"]},
                execute=exec_retrieve_knowledge,
            )
        )
        self.register(
            AgentToolDefinition(
                id="retrieve_memory",
                name="Approved User Memory Retrieval",
                category="memory",
                description="Retrieves explicitly approved User Memory records from SQLite.",
                risk_level="read_only",
                requires_approval=False,
                safe_retryable=True,
                operational=True,
                input_schema={"type": "object", "required": ["query"]},
                execute=exec_retrieve_memory,
            )
        )
        self.register(
            AgentToolDefinition(
                id="local_workspace_ops",
                name="Local Application Operations",
                category="local_app",
                description="Read-only inspection of workspace files, registered models, memory counts, and tokenizer.",
                risk_level="read_only",
                requires_approval=False,
                safe_retryable=True,
                operational=True,
                input_schema={"type": "object"},
                execute=exec_local_ops,
            )
        )

        # Backward-compatible Step 01 aliases
        for alias_id, op_name, desc in [
            ("health_check", "summary", "Read-only system & SQLite workspace telemetry check."),
            ("inspect_tokenizer", "tokenize", "Local deterministic text segmentation & byte count inspection."),
            ("list_models", "list_models", "Enumerates locally registered model manifests."),
        ]:
            self.register(
                AgentToolDefinition(
                    id=alias_id,
                    name=alias_id.replace("_", " ").title(),
                    category="local_app",
                    description=desc,
                    risk_level="read_only",
                    requires_approval=False,
                    safe_retryable=True,
                    operational=True,
                    input_schema={"type": "object"},
                    execute=lambda inp, ctx, op=op_name: exec_local_ops({**inp, "operation": op}, ctx),
                )
            )
        self.register(
            AgentToolDefinition(
                id="validate_json_schema",
                name="JSON Structural Validator",
                category="local_app",
                description="Parses JSON payloads safely without code evaluation.",
                risk_level="read_only",
                requires_approval=False,
                safe_retryable=True,
                operational=True,
                input_schema={"type": "object"},
                execute=lambda inp, _ctx: AgentToolResult(
                    ok=True,
                    summary="JSON payload parsed cleanly.",
                    data={"valid": True, "parsed_type": type(json.loads(str(inp.get("json_text") or "{}"))).__name__},
                ),
            )
        )

        # Reserved Future Extension Interfaces (NOT claimed operational)
        for fut_id, fut_name, fut_desc in [
            (
                "web_search_future",
                "Web Search Adapter (Interface Reserved)",
                "Reserved extension interface for Step 08+ Web Search integration. Not operational in Step 07.",
            ),
            (
                "public_data_future",
                "Public Data Sources Adapter (Interface Reserved)",
                "Reserved extension interface for verified public datasets. Not operational in Step 07.",
            ),
            (
                "world_intelligence_future",
                "World Intelligence Interface (Interface Reserved)",
                "Reserved extension interface for World Intelligence feeds. Not operational in Step 07.",
            ),
        ]:
            self.register(
                AgentToolDefinition(
                    id=fut_id,
                    name=fut_name,
                    category="future_extension",
                    description=fut_desc,
                    risk_level="reserved_stub",
                    requires_approval=True,
                    safe_retryable=False,
                    operational=False,
                    input_schema={"type": "object"},
                    execute=lambda _inp, _ctx, fid=fut_id: AgentToolResult(
                        ok=False,
                        summary="Reserved future interface (Step 08+).",
                        data={"operational": False},
                        error=f"Tool '{fid}' is a reserved interface and is not implemented in Step 07.",
                    ),
                )
            )


default_tool_registry = AgentToolRegistry()
