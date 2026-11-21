"""
CPU-First PyTorch Training Loop for Experimental Genesis Core Model.

Supports:
- Windows CPU thread management & limited RAM micro-batch gradient accumulation
- Linear warmup + cosine learning rate decay
- Periodic validation split evaluation
- Progress callbacks & JSON metrics logging
- Best + latest checkpoint + tokenizer persistence
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any, Callable

from genesis_core.checkpoint import save_checkpoint
from genesis_core.config import GenesisCoreConfig, TrainingConfig
from genesis_core.dataset import TextSequenceBatcher
from genesis_core.model import GenesisCoreTransformer, HAS_TORCH
from genesis_core.tokenizer import GenesisByteBPETokenizer

if HAS_TORCH:
    import torch


ProgressCallback = Callable[[dict[str, Any]], None]


class GenesisCoreTrainer:
    """
    Self-contained CPU-first training runner for local text experimentation.
    """

    def __init__(
        self,
        model: GenesisCoreTransformer,
        tokenizer: GenesisByteBPETokenizer,
        batcher: TextSequenceBatcher,
        model_config: GenesisCoreConfig,
        train_config: TrainingConfig,
    ) -> None:
        if not HAS_TORCH:
            raise RuntimeError(
                "PyTorch is required to run GenesisCoreTrainer. "
                "Install CPU PyTorch with: pip install torch --index-url https://download.pytorch.org/whl/cpu"
            )

        self.model = model
        self.tokenizer = tokenizer
        self.batcher = batcher
        self.model_config = model_config
        self.train_config = train_config
        self.device = train_config.device or "cpu"

        if self.device == "cpu":
            torch.set_num_threads(max(1, int(train_config.num_threads)))
        torch.manual_seed(int(train_config.seed))

        self.model.to(self.device)
        self.optimizer = self._create_optimizer()
        self.history: list[dict[str, Any]] = []

    def _create_optimizer(self) -> Any:
        decay_params = []
        no_decay_params = []
        for name, param in self.model.named_parameters():
            if not param.requires_grad:
                continue
            if param.dim() >= 2 and "embedding" not in name:
                decay_params.append(param)
            else:
                no_decay_params.append(param)

        groups = [
            {"params": decay_params, "weight_decay": self.train_config.weight_decay},
            {"params": no_decay_params, "weight_decay": 0.0},
        ]
        return torch.optim.AdamW(groups, lr=self.train_config.learning_rate, betas=(0.9, 0.95))

    def _compute_lr(self, step: int) -> float:
        cfg = self.train_config
        if step <= cfg.warmup_steps:
            return cfg.learning_rate * float(step) / float(max(1, cfg.warmup_steps))
        if step >= cfg.max_steps:
            return cfg.min_lr
        progress = float(step - cfg.warmup_steps) / float(
            max(1, cfg.max_steps - cfg.warmup_steps)
        )
        cosine = 0.5 * (1.0 + math.cos(math.pi * progress))
        return cfg.min_lr + cosine * (cfg.learning_rate - cfg.min_lr)

    def evaluate_loss(self, split: str = "val", num_batches: int | None = None) -> float:
        was_training = self.model.training
        self.model.eval()
        batches = num_batches or self.train_config.eval_batches
        total = 0.0
        try:
            with torch.no_grad():
                for _ in range(batches):
                    x, y = self.batcher.get_torch_batch(
                        split,
                        self.train_config.batch_size,
                        device=self.device,
                    )
                    _, loss = self.model(x, y)
                    total += float(loss.item())
            return total / float(max(1, batches))
        finally:
            if was_training:
                self.model.train()

    def train(
        self,
        on_progress: ProgressCallback | None = None,
        corpus_provenance: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ckpt_dir = Path(self.train_config.checkpoint_dir)
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        tokenizer_path = self.tokenizer.save(ckpt_dir / "tokenizer.json")
        latest_ckpt_path = ckpt_dir / "latest.pt"
        best_ckpt_path = ckpt_dir / "best.pt"

        best_val_loss = float("inf")
        last_val_loss: float | None = None
        last_train_loss: float | None = None
        start_time = time.perf_counter()

        self.model.train()
        for step in range(1, self.train_config.max_steps + 1):
            step_start = time.perf_counter()
            lr = self._compute_lr(step)
            for pg in self.optimizer.param_groups:
                pg["lr"] = lr

            self.optimizer.zero_grad(set_to_none=True)
            accum_loss = 0.0
            tokens_processed = 0

            for _ in range(self.train_config.gradient_accumulation_steps):
                x, y = self.batcher.get_torch_batch(
                    "train",
                    self.train_config.batch_size,
                    device=self.device,
                )
                tokens_processed += int(x.numel())
                _, loss = self.model(x, y)
                scaled = loss / float(self.train_config.gradient_accumulation_steps)
                scaled.backward()
                accum_loss += float(scaled.item())

            grad_norm = torch.nn.utils.clip_grad_norm_(
                self.model.parameters(), self.train_config.grad_clip
            )
            self.optimizer.step()

            step_elapsed = max(1e-6, time.perf_counter() - step_start)
            last_train_loss = accum_loss

            should_eval = (
                step == 1
                or step % self.train_config.eval_interval == 0
                or step == self.train_config.max_steps
            )
            if should_eval:
                last_val_loss = self.evaluate_loss("val")

            event = {
                "step": step,
                "max_steps": self.train_config.max_steps,
                "train_loss": round(accum_loss, 5),
                "val_loss": round(last_val_loss, 5) if last_val_loss is not None else None,
                "lr": round(lr, 7),
                "grad_norm": round(float(grad_norm), 4),
                "tokens_per_sec": round(tokens_processed / step_elapsed, 1),
                "experimental": True,
            }
            self.history.append(event)
            if on_progress:
                on_progress(event)

            extra_meta = {"corpus_provenance": corpus_provenance or {}}
            if last_val_loss is not None and last_val_loss < best_val_loss:
                best_val_loss = last_val_loss
                save_checkpoint(
                    best_ckpt_path,
                    self.model,
                    self.optimizer,
                    self.model_config,
                    self.train_config,
                    step=step,
                    train_loss=last_train_loss,
                    val_loss=last_val_loss,
                    tokenizer_path=tokenizer_path,
                    extra_meta=extra_meta,
                )

            if (
                step % self.train_config.save_interval == 0
                or step == self.train_config.max_steps
            ):
                save_checkpoint(
                    latest_ckpt_path,
                    self.model,
                    self.optimizer,
                    self.model_config,
                    self.train_config,
                    step=step,
                    train_loss=last_train_loss,
                    val_loss=last_val_loss,
                    tokenizer_path=tokenizer_path,
                    extra_meta=extra_meta,
                )

        total_seconds = round(time.perf_counter() - start_time, 3)
        summary = {
            "experimental": True,
            "model_status": "experimental_trained",
            "steps_completed": self.train_config.max_steps,
            "final_train_loss": round(last_train_loss or 0.0, 5),
            "final_val_loss": round(last_val_loss or 0.0, 5),
            "best_val_loss": round(best_val_loss, 5) if math.isfinite(best_val_loss) else None,
            "parameter_count": self.model.count_parameters(),
            "elapsed_seconds": total_seconds,
            "latest_checkpoint": str(latest_ckpt_path),
            "best_checkpoint": str(best_ckpt_path),
            "tokenizer_path": str(tokenizer_path),
            "history": self.history,
        }
        (ckpt_dir / "training_metrics.json").write_text(
            json.dumps(summary, indent=2), encoding="utf-8"
        )
        return summary
