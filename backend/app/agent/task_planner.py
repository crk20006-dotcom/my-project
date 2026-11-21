import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any

from app.ai.memory_retrieval import SqliteKeywordRetriever
from app.agent.tool_registry import AgentToolRegistry, default_tool_registry


@dataclass
class PlannedTaskStep:
    step_index: int
    title: str
    description: str
    tool_name: str
    tool_input: dict[str, Any]
    requires_approval: bool
    safe_retryable: bool


class AgentTaskPlanner:
    def __init__(self, registry: AgentToolRegistry = default_tool_registry) -> None:
        self.registry = registry

    def plan_task(
        self,
        conn: sqlite3.Connection,
        *,
        goal: str,
        allowed_tools: list[str],
        max_steps: int = 6,
        title: str | None = None,
        target_file_path: str | None = None,
        document_filename: str | None = None,
        code_snippet: str | None = None,
    ) -> dict[str, Any]:
        cleaned_goal = goal.strip()
        lower = cleaned_goal.lower()
        step_limit = min(12, max(1, max_steps or 6))
        allowed = set(allowed_tools)

        retriever = SqliteKeywordRetriever(conn)
        retrieval = retriever.retrieve(
            cleaned_goal,
            include_memory=True,
            include_knowledge=True,
            max_memory_items=3,
            max_knowledge_chunks=3,
            context_length=8192,
        )

        steps: list[PlannedTaskStep] = []

        def push_step(step_title: str, desc: str, tool_name: str, tool_input: dict[str, Any]) -> None:
            if len(steps) >= step_limit or tool_name not in allowed:
                return
            definition = self.registry.get(tool_name)
            if not definition or not definition.operational:
                return
            steps.append(
                PlannedTaskStep(
                    step_index=len(steps),
                    title=step_title,
                    description=desc,
                    tool_name=tool_name,
                    tool_input=tool_input,
                    requires_approval=definition.requires_approval,
                    safe_retryable=definition.safe_retryable,
                )
            )

        if "retrieve_memory" in allowed:
            push_step(
                "Retrieve Approved User Memory",
                "Query approved local facts, preferences, and constraints relevant to the task.",
                "retrieve_memory",
                {"query": cleaned_goal, "max_items": 3},
            )

        if "retrieve_knowledge" in allowed:
            push_step(
                "Search Local Knowledge Base",
                "Retrieve matching document chunks from local SQLite FTS5 index.",
                "retrieve_knowledge",
                {"query": cleaned_goal, "max_chunks": 3},
            )

        if "read_workspace_file" in allowed and (
            target_file_path or re.search(r"\b(file|read|readme|doc|workspace|inspect)\b", lower)
        ):
            push_step(
                "Read & Process Workspace File",
                "Inspect approved file content and compute size, line count, and checksum.",
                "read_workspace_file",
                {"path": (target_file_path or "workspace_readme.txt").strip(), "max_preview_chars": 1200},
            )

        if "run_restricted_code" in allowed and (
            (code_snippet and code_snippet.strip())
            or re.search(r"\b(calculate|compute|script|code|evaluate|math|expression)\b", lower)
        ):
            words = len([w for w in cleaned_goal.split() if w])
            snippet = (
                code_snippet.strip()
                if code_snippet and code_snippet.strip()
                else f"goal_words = {words}\nprint('Analyzed goal word count:', goal_words)\nresult = {{'goal_words': goal_words, 'status': 'evaluated'}}"
            )
            push_step(
                "Run Restricted Code Sandbox",
                "Execute deterministic calculation in isolated AST sandbox (requires explicit approval).",
                "run_restricted_code",
                {"code": snippet},
            )

        if "local_workspace_ops" in allowed:
            op = (
                "list_models"
                if re.search(r"\b(model|weights)\b", lower)
                else "list_workspace_files"
                if re.search(r"\b(files|directory|folder)\b", lower)
                else "summary"
            )
            push_step(
                "Run Local Workspace Inspection",
                "Gather real-time local workspace status and manifest metrics.",
                "local_workspace_ops",
                {"operation": op},
            )
        elif "health_check" in allowed:
            push_step("Check Workspace Health", "Collect read-only local telemetry.", "health_check", {})

        if "create_document" in allowed and (
            (document_filename and document_filename.strip())
            or re.search(r"\b(document|report|write|create|note|summary|brief|export)\b", lower)
        ):
            filename = (document_filename or "task_summary.md").strip()
            mem_lines = (
                "\n".join(f"- {m['title']}: {m['content']}" for m in retrieval["memories"])
                if retrieval["memories"]
                else "- No matching approved user memory entries."
            )
            kb_lines = (
                "\n".join(f"- {k['document_title']} (chunk #{k['chunk_index']}): {k['content'][:220]}" for k in retrieval["knowledge"])
                if retrieval["knowledge"]
                else "- No matching knowledge base chunks."
            )
            doc_title = (title or "Genesis Agent Task Report").strip()
            doc_content = (
                f"# {doc_title}\n\n"
                f"**Goal:** {cleaned_goal}\n\n"
                f"## Approved User Memory Context\n{mem_lines}\n\n"
                f"## Knowledge Base Excerpts\n{kb_lines}"
            )
            push_step(
                "Create Workspace Summary Document",
                "Write validated markdown output inside ./data/agent_workspace/documents (requires explicit approval).",
                "create_document",
                {"filename": filename, "title": doc_title, "content": doc_content},
            )

        if not steps:
            if "inspect_tokenizer" in allowed:
                push_step("Inspect Task Tokens", "Compute baseline token count.", "inspect_tokenizer", {"text": cleaned_goal})
            if "list_models" in allowed:
                push_step("Enumerate Registered Models", "Inspect local model adapters.", "list_models", {})
            if "validate_json_schema" in allowed:
                push_step(
                    "Validate Structured Task Payload",
                    "Run structural JSON check.",
                    "validate_json_schema",
                    {"json_text": json.dumps({"goal": cleaned_goal})},
                )

        derived_title = (title or "").strip() or (
            f"{cleaned_goal[:61].strip()}..." if len(cleaned_goal) > 64 else cleaned_goal
        )

        return {
            "title": derived_title,
            "planner_mode": "deterministic_local",
            "memory_context": {
                "memories": [
                    {"id": m["id"], "title": m["title"], "category": m["category"]} for m in retrieval["memories"]
                ],
                "knowledge": [
                    {
                        "document_id": k["document_id"],
                        "document_title": k["document_title"],
                        "chunk_index": k["chunk_index"],
                    }
                    for k in retrieval["knowledge"]
                ],
            },
            "steps": [
                {
                    "step_index": s.step_index,
                    "title": s.title,
                    "description": s.description,
                    "tool_name": s.tool_name,
                    "tool_input": s.tool_input,
                    "requires_approval": s.requires_approval,
                    "safe_retryable": s.safe_retryable,
                }
                for s in steps
            ],
        }


default_task_planner = AgentTaskPlanner(default_tool_registry)
