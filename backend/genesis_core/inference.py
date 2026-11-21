"""
Local Checkpoint Inference Interface for Experimental Genesis Core Models.

Strictly enforces honest state reporting:
- Refuses to fabricate text when untrained (`trained_steps == 0`), missing weights,
  or when PyTorch is unavailable.
- Always marks every result `experimental=True`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from genesis_core.checkpoint import inspect_checkpoint_metadata, load_checkpoint
from genesis_core.config import GenesisCoreConfig
from genesis_core.model import HAS_TORCH
from genesis_core.tokenizer import GenesisByteBPETokenizer

if HAS_TORCH:
    import torch


class GenesisCoreLocalInference:
    """
    Loads a locally trained Genesis Core checkpoint + tokenizer and generates text tokens.
    """

    def __init__(
        self,
        model: Any | None = None,
        tokenizer: GenesisByteBPETokenizer | None = None,
        model_config: GenesisCoreConfig | None = None,
        checkpoint_path: str | Path | None = None,
        trained_steps: int = 0,
        last_val_loss: float | None = None,
        device: str = "cpu",
    ) -> None:
        self.model = model
        self.tokenizer = tokenizer or GenesisByteBPETokenizer()
        self.model_config = model_config or GenesisCoreConfig.cpu_micro()
        self.checkpoint_path = str(checkpoint_path) if checkpoint_path else None
        self.trained_steps = int(trained_steps)
        self.last_val_loss = last_val_loss
        self.device = device
        self.experimental = True

    @property
    def is_loaded(self) -> bool:
        return bool(HAS_TORCH and self.model is not None)

    @property
    def is_trained(self) -> bool:
        return bool(self.is_loaded and self.trained_steps > 0)

    def status_summary(self) -> dict[str, Any]:
        return {
            "experimental": True,
            "torch_available": HAS_TORCH,
            "is_loaded": self.is_loaded,
            "is_trained": self.is_trained,
            "model_status": "experimental_trained" if self.is_trained else "untrained_experimental",
            "trained_steps": self.trained_steps,
            "last_val_loss": self.last_val_loss,
            "checkpoint_path": self.checkpoint_path,
            "vocab_size": self.model_config.vocab_size,
            "context_length": self.model_config.context_length,
        }

    @classmethod
    def from_checkpoint(
        cls,
        checkpoint_path: str | Path,
        tokenizer_path: str | Path | None = None,
        device: str = "cpu",
    ) -> GenesisCoreLocalInference:
        ckpt_path = Path(checkpoint_path)
        if not HAS_TORCH:
            meta = inspect_checkpoint_metadata(ckpt_path)
            raise RuntimeError(
                "PyTorch is not installed in this Python runtime; cannot load "
                f"checkpoint {ckpt_path} (metadata trained_steps={meta['trained_steps']})."
            )

        loaded = load_checkpoint(ckpt_path, device=device)
        resolved_tok_path = (
            Path(tokenizer_path)
            if tokenizer_path
            else (
                Path(loaded["tokenizer_path"])
                if loaded.get("tokenizer_path")
                else ckpt_path.parent / "tokenizer.json"
            )
        )
        tokenizer = (
            GenesisByteBPETokenizer.load(resolved_tok_path)
            if resolved_tok_path.exists()
            else GenesisByteBPETokenizer()
        )
        return cls(
            model=loaded["model"],
            tokenizer=tokenizer,
            model_config=loaded["model_config"],
            checkpoint_path=ckpt_path,
            trained_steps=loaded["step"],
            last_val_loss=loaded.get("val_loss"),
            device=device,
        )

    def generate_text(
        self,
        prompt: str,
        max_new_tokens: int = 64,
        temperature: float = 0.8,
        top_k: int | None = 40,
    ) -> dict[str, Any]:
        if not HAS_TORCH:
            return {
                "ok": False,
                "experimental": True,
                "trained": False,
                "trained_steps": self.trained_steps,
                "mode": "demo",
                "text": "",
                "finish_reason": "not_connected",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "error": "PyTorch is not installed in this runtime.",
            }

        if not self.is_loaded or self.model is None:
            return {
                "ok": False,
                "experimental": True,
                "trained": False,
                "trained_steps": 0,
                "mode": "demo",
                "text": "",
                "finish_reason": "not_connected",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "error": "No trained Genesis Core checkpoint is currently loaded.",
            }

        if not self.is_trained:
            return {
                "ok": False,
                "experimental": True,
                "trained": False,
                "trained_steps": self.trained_steps,
                "mode": "demo",
                "text": "",
                "finish_reason": "not_connected",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "error": "Loaded Genesis Core model has 0 training steps (untrained prototype).",
            }

        prompt_ids = self.tokenizer.encode(prompt, add_bos=True)
        if not prompt_ids:
            prompt_ids = [self.tokenizer.bos_token_id]

        # Truncate left side if prompt exceeds context window
        max_ctx = self.model_config.context_length
        if len(prompt_ids) > max_ctx:
            prompt_ids = prompt_ids[-max_ctx:]

        idx = torch.tensor([prompt_ids], dtype=torch.long, device=self.device)
        bounded_tokens = min(max(1, int(max_new_tokens)), max_ctx)
        out_ids_tensor = self.model.generate(
            idx,
            max_new_tokens=bounded_tokens,
            temperature=temperature,
            top_k=top_k,
            eos_token_id=self.tokenizer.eos_token_id,
        )
        full_ids = [int(t) for t in out_ids_tensor[0].tolist()]
        new_ids = full_ids[len(prompt_ids) :]
        completion_text = self.tokenizer.decode(new_ids, skip_special_tokens=True)

        return {
            "ok": True,
            "experimental": True,
            "trained": True,
            "trained_steps": self.trained_steps,
            "mode": "genesis_core",
            "text": completion_text,
            "finish_reason": (
                "stop"
                if (new_ids and new_ids[-1] == self.tokenizer.eos_token_id)
                else "length"
            ),
            "usage": {
                "prompt_tokens": len(prompt_ids),
                "completion_tokens": len(new_ids),
            },
            "error": None,
        }
