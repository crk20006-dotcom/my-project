import json
import sqlite3
from typing import Any
from app.ai.genesis_core_adapter import GenesisCorePlaceholderAdapter
from app.ai.interfaces import BaseInferenceEngine
from app.ai.local_inference_adapter import LocalHttpInferenceAdapter, LocalWeightsManifestAdapter
from app.ai.tokenizer import BaselineTokenizer

_tokenizer = BaselineTokenizer()
_GENESIS_CORE_ADAPTER_CACHE: dict[str, GenesisCorePlaceholderAdapter] = {}


def clear_genesis_core_adapter_cache(model_id: str | None = None) -> None:
    if model_id is None:
        _GENESIS_CORE_ADAPTER_CACHE.clear()
    else:
        _GENESIS_CORE_ADAPTER_CACHE.pop(model_id, None)


def build_context_messages(
    history: list[dict[str, str]],
    context_length: int,
    max_output_tokens: int,
    system_prompt: str | None = None,
) -> tuple[list[dict[str, str]], int, int]:
    """
    Pack newest messages first within `context_length - reserved_output` token budget.
    Returns (packed_messages, estimated_prompt_tokens, truncated_messages_count).
    """
    safe_context = max(512, context_length or 8192)
    reserved_output = min(safe_context // 2, max(32, max_output_tokens or 512))
    budget = max(256, safe_context - reserved_output)

    prefix: list[dict[str, str]] = []
    used_tokens = 0

    if system_prompt and system_prompt.strip():
        sys_tokens = _tokenizer.inspect(system_prompt, safe_context)["token_count"] + 4
        if sys_tokens < budget:
            budget -= sys_tokens
            used_tokens += sys_tokens
            prefix.append({"role": "system", "content": system_prompt.strip()})

    selected_reversed: list[dict[str, str]] = []
    truncated_count = 0

    for idx in range(len(history) - 1, -1, -1):
        item = history[idx]
        content = item.get("content") or ""
        role = item.get("role") or "user"
        msg_tokens = _tokenizer.inspect(content, safe_context)["token_count"] + 4
        if not selected_reversed and msg_tokens > budget:
            max_chars = max(256, budget * 3)
            selected_reversed.append({"role": role, "content": content[:max_chars]})
            used_tokens += min(msg_tokens, budget)
            budget = 0
            truncated_count += idx
            break
        if msg_tokens <= budget:
            selected_reversed.append({"role": role, "content": content})
            used_tokens += msg_tokens
            budget -= msg_tokens
        else:
            truncated_count += idx + 1
            break

    selected_reversed.reverse()
    return ([*prefix, *selected_reversed], used_tokens, truncated_count)


def resolve_model_adapter(
    conn: sqlite3.Connection,
    requested_model_id: str | None,
    default_inference_url: str,
) -> tuple[BaseInferenceEngine, dict[str, Any]]:
    """
    Resolve a registered model row into its concrete BaseInferenceEngine adapter.
    Raises LookupError when requested_model_id is missing from the registry.
    """
    effective_id = requested_model_id or "genesis-core-placeholder"
    row = conn.execute("SELECT * FROM models WHERE id = ?", (effective_id,)).fetchone()
    if not row:
        raise LookupError(f'Model "{effective_id}" not found in model registry.')

    model = dict(row)
    try:
        meta = json.loads(model.get("metadata_json") or "{}")
    except Exception:
        meta = {}

    context_len = int(model.get("context_length") or 8192)
    provider = str(model.get("provider") or "")

    if provider == "genesis_core":
        raw_path = str(model.get("local_path") or "").strip()
        if not raw_path or raw_path == "./weights/genesis-core-v0.safetensors":
            raw_path = "./data/checkpoints/genesis_core/latest.pt"
        model_key = str(model["id"])
        cached = _GENESIS_CORE_ADAPTER_CACHE.get(model_key)
        if cached is None:
            cached = GenesisCorePlaceholderAdapter(
                model_id=model_key,
                weights_path=raw_path,
                context_length=context_len or 128,
            )
            _GENESIS_CORE_ADAPTER_CACHE[model_key] = cached
        return (cached, model)

    endpoint = str(model.get("endpoint_url") or "").strip()
    if not endpoint and model["id"] == "local-inference-http":
        endpoint = default_inference_url.strip()

    if provider == "local_http" or endpoint:
        server_model = meta.get("server_model") if isinstance(meta, dict) else None
        return (
            LocalHttpInferenceAdapter(
                endpoint_url=endpoint,
                model_id=str(model["id"]),
                provider=provider or "local_http",
                model_label=str(model.get("name") or "Local Inference Server"),
                server_model_name=str(server_model) if server_model else None,
                context_length=context_len,
            ),
            model,
        )

    return (
        LocalWeightsManifestAdapter(
            model_id=str(model["id"]),
            model_name=str(model.get("name") or model["id"]),
            provider=provider or "gguf_local",
            local_path=str(model.get("local_path") or ""),
            context_length=context_len,
        ),
        model,
    )
