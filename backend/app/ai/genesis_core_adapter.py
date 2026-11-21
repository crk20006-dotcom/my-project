import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.ai.interfaces import (
    BaseInferenceEngine,
    BaseModelAdapter,
    InferenceChunk,
    InferenceRequest,
    InferenceResponse,
    ModelCapabilities,
)
from app.ai.tokenizer import BaselineTokenizer
from genesis_core.checkpoint import HAS_TORCH, inspect_checkpoint_metadata
from genesis_core.inference import GenesisCoreLocalInference


DEFAULT_GENESIS_CHECKPOINT = "./data/checkpoints/genesis_core/latest.pt"


def _format_messages_for_lm(messages: list[dict[str, str]]) -> str:
    parts: list[str] = []
    for msg in messages:
        role = str(msg.get("role") or "user").strip().lower()
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            parts.append(f"System: {content}")
        elif role == "assistant":
            parts.append(f"Assistant: {content}")
        else:
            parts.append(f"User: {content}")
    parts.append("Assistant:")
    return "\n".join(parts)


class GenesisCorePlaceholderAdapter(BaseModelAdapter, BaseInferenceEngine):
    """
    Adapter connecting the Genesis Intelligence Engine to our independently developed
    experimental Genesis Core PyTorch Transformer (`backend/genesis_core/`).

    - Never calls external AI APIs or downloads pretrained weights.
    - Never auto-loads weights during startup or health probes.
    - Explicitly stays in Demo Mode (`untrained_experimental`) until trained local
      checkpoint weights are explicitly loaded and verified.
    """

    def __init__(
        self,
        model_id: str = "genesis-core-placeholder",
        weights_path: str = DEFAULT_GENESIS_CHECKPOINT,
        context_length: int = 128,
        tokenizer_path: str | None = None,
    ) -> None:
        self._model_id = model_id
        self._weights_path = weights_path
        self._tokenizer_path = tokenizer_path
        self._context_length = context_length
        self._loaded = False
        self._inference: GenesisCoreLocalInference | None = None
        self._tokenizer = BaselineTokenizer()

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def is_loaded(self) -> bool:
        return bool(self._loaded and self._inference and self._inference.is_trained)

    async def load_weights(self, local_path: str | None = None) -> tuple[bool, str]:
        target = (local_path or self._weights_path).strip()
        meta = inspect_checkpoint_metadata(target)

        if not meta["checkpoint_exists"]:
            self._loaded = False
            self._inference = None
            return (
                False,
                f"Untrained / Experimental Prototype: no Genesis Core checkpoint found at {target}. "
                "Train locally via `python backend/scripts/train_genesis_core.py --corpus <local_path>`.",
            )

        if not HAS_TORCH:
            self._loaded = False
            self._inference = None
            return (
                False,
                "PyTorch is not installed in this Python runtime; checkpoint metadata inspected "
                f"(trained_steps={meta['trained_steps']}, experimental=True) but tensor weights cannot load.",
            )

        try:
            runtime = GenesisCoreLocalInference.from_checkpoint(
                target,
                tokenizer_path=self._tokenizer_path,
                device="cpu",
            )
        except Exception as exc:
            self._loaded = False
            self._inference = None
            return (False, f"Failed to load Genesis Core checkpoint: {exc}")

        if not runtime.is_trained:
            self._loaded = False
            self._inference = None
            return (
                False,
                "Checkpoint has 0 completed training steps (untrained_experimental).",
            )

        self._weights_path = target
        self._inference = runtime
        self._loaded = True
        self._context_length = runtime.model_config.context_length
        return (
            True,
            f"Loaded experimental Genesis Core checkpoint ({runtime.trained_steps} steps, "
            f"val_loss={runtime.last_val_loss}, vocab={runtime.model_config.vocab_size}).",
        )

    async def unload_weights(self) -> None:
        self._loaded = False
        self._inference = None

    def get_capabilities(self) -> ModelCapabilities:
        return ModelCapabilities(
            max_context_tokens=self._context_length,
            supports_streaming=False,
            supports_tool_calling=False,
            provider="genesis_core",
        )

    async def health_probe(self) -> dict[str, Any]:
        meta = inspect_checkpoint_metadata(self._weights_path)
        if self.is_loaded and self._inference is not None:
            return {
                "reachable": True,
                "status_code": 200,
                "detected_models": [f"genesis-core-experimental ({self._inference.trained_steps} steps)"],
                "server_model": f"genesis-core-experimental-{self._inference.trained_steps}steps",
                "experimental": True,
                "trained": True,
                "model_status": "experimental_trained",
                "torch_available": HAS_TORCH,
                "checkpoint_meta": meta,
                "message": (
                    f"Experimental Genesis Core weights loaded ({self._inference.trained_steps} training steps, "
                    f"last_val_loss={self._inference.last_val_loss}). Not a general-purpose pretrained assistant."
                ),
            }

        if meta["checkpoint_exists"] and meta["trained"]:
            return {
                "reachable": False,
                "status_code": None,
                "detected_models": [],
                "server_model": None,
                "experimental": True,
                "trained": True,
                "model_status": "experimental_trained",
                "torch_available": HAS_TORCH,
                "checkpoint_meta": meta,
                "message": (
                    f"Experimental Genesis Core checkpoint found at {self._weights_path} "
                    f"({meta['trained_steps']} steps, val_loss={meta.get('val_loss')}) — staged/unloaded "
                    "until explicitly loaded."
                ),
            }

        return {
            "reachable": False,
            "status_code": None,
            "detected_models": [],
            "server_model": None,
            "experimental": True,
            "trained": False,
            "model_status": "untrained_experimental",
            "torch_available": HAS_TORCH,
            "checkpoint_meta": meta,
            "message": (
                f"Genesis Core is an untrained experimental prototype (architecture ready in backend/genesis_core/). "
                f"No trained checkpoint found at {self._weights_path}."
            ),
        }

    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        if self.is_loaded and self._inference is not None:
            prompt_text = _format_messages_for_lm(request.messages)
            res = self._inference.generate_text(
                prompt=prompt_text,
                max_new_tokens=request.max_tokens,
                temperature=request.temperature,
                top_k=40,
            )
            if res["ok"]:
                return InferenceResponse(
                    ok=True,
                    mode="genesis_core",
                    model_name=f"GENESIS CORE (Experimental · {self._inference.trained_steps} steps)",
                    finish_reason=str(res.get("finish_reason") or "stop"),
                    diagnostic=False,
                    content=str(res.get("text") or ""),
                    usage=res.get("usage"),
                )

        last_user = next(
            (m["content"] for m in reversed(request.messages) if m.get("role") == "user"),
            "",
        )
        system_msg = next(
            (m["content"] for m in request.messages if m.get("role") == "system"),
            "",
        )
        has_memory = "[Approved User Memory]" in system_msg
        has_knowledge = "[Knowledge Base Excerpts]" in system_msg
        stats = self._tokenizer.inspect(last_user, self._context_length)
        meta = inspect_checkpoint_metadata(self._weights_path)
        lines = [
            "### Demo Mode — Genesis Core (Untrained / Experimental Prototype)",
            "",
            "Your message was persisted to the local SQLite database. "
            "No external AI API is attached and **GENESIS CORE** is currently in "
            "**untrained experimental prototype** state (no trained local checkpoint loaded).",
            "",
            f"- **Message Tokens (Baseline)**: `{stats['token_count']}` tokens (`{stats['byte_count']}` UTF-8 bytes)",
            f"- **Checkpoint Slot**: `{self._weights_path}` (`trained_steps={meta['trained_steps']}` · `torch_available={HAS_TORCH}`)",
            "- **Local Training CLI**: `python backend/scripts/train_genesis_core.py --corpus <local_text_dir> --preset cpu_nano`",
        ]
        if has_memory or has_knowledge:
            sources: list[str] = []
            if has_memory:
                sources.append("Approved User Memory")
            if has_knowledge:
                sources.append("Knowledge Base Excerpts")
            lines.append(
                f"- **Local Context Retrieved**: {' + '.join(sources)} attached to prompt context "
                "(keyword retrieval only — not AI reasoning)."
            )
            excerpt_lines = [line for line in system_msg.splitlines() if line.startswith("- (")][:4]
            if excerpt_lines:
                lines.extend(["", "**Retrieved Local Snippets (Raw Context Preview):**", *excerpt_lines])

        content = "\n".join(lines)
        return InferenceResponse(
            ok=True,
            mode="demo",
            model_name="DEMO MODE (GENESIS CORE Untrained Experimental)",
            finish_reason="not_connected",
            diagnostic=True,
            content=content,
            usage={
                "prompt_tokens": stats["token_count"],
                "completion_tokens": self._tokenizer.inspect(content, self._context_length)["token_count"],
            },
        )

    async def generate_stream(self, request: InferenceRequest) -> AsyncIterator[InferenceChunk]:
        res = await self.generate(request)
        yield InferenceChunk(
            type="done",
            content=res.content,
            mode=res.mode,
            model_name=res.model_name,
            finish_reason=res.finish_reason,
            usage=res.usage,
            diagnostic=res.diagnostic,
        )


GenesisCoreExperimentalAdapter = GenesisCorePlaceholderAdapter
