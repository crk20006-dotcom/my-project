"""
CPU-First Training Script for Experimental Genesis Core Model.

Usage example (Windows / macOS / Linux):
  python backend/scripts/train_genesis_core.py --corpus ./README.md ./docs --preset cpu_nano --steps 100

Notes:
- Loads only local filesystem text files (never downloads remote corpora or pretrained weights).
- Configured for Windows CPU experimentation with low RAM (`batch_size=4`, `grad_accum=4`).
- Explicitly marks every checkpoint and output as experimental.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from genesis_core.config import (
    GenesisCoreConfig,
    TrainingConfig,
    build_preset_config,
)
from genesis_core.dataset import (
    TextSequenceBatcher,
    create_train_val_splits,
    load_local_text_corpus,
)
from genesis_core.inference import GenesisCoreLocalInference
from genesis_core.model import GenesisCoreTransformer, HAS_TORCH
from genesis_core.tokenizer import GenesisByteBPETokenizer
from genesis_core.trainer import GenesisCoreTrainer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train an experimental Genesis Core prototype on local text files (CPU-first)."
    )
    parser.add_argument(
        "--corpus",
        nargs="+",
        required=True,
        help="One or more local text files or directories (.txt, .md, .py, .json, .csv, .log).",
    )
    parser.add_argument(
        "--preset",
        choices=["cpu_nano", "cpu_micro", "cpu_small"],
        default="cpu_nano",
        help="Model size preset optimized for limited-RAM CPU experiments (default: cpu_nano).",
    )
    parser.add_argument("--vocab-size", type=int, default=None, help="Override target BPE vocab size (>=260).")
    parser.add_argument("--context-length", type=int, default=None, help="Override context window length.")
    parser.add_argument("--d-model", type=int, default=None, help="Override embedding dimension.")
    parser.add_argument("--n-heads", type=int, default=None, help="Override attention head count.")
    parser.add_argument("--n-layers", type=int, default=None, help="Override transformer layer count.")
    parser.add_argument("--steps", type=int, default=100, help="Total optimizer training steps (default: 100).")
    parser.add_argument("--batch-size", type=int, default=4, help="Micro-batch size (default: 4).")
    parser.add_argument("--grad-accum", type=int, default=4, help="Gradient accumulation steps (default: 4).")
    parser.add_argument("--lr", type=float, default=3e-4, help="Peak learning rate (default: 3e-4).")
    parser.add_argument("--val-split", type=float, default=0.1, help="Validation split fraction (default: 0.1).")
    parser.add_argument("--threads", type=int, default=4, help="CPU thread limit (default: 4).")
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42).")
    parser.add_argument(
        "--checkpoint-dir",
        default="./data/checkpoints/genesis_core",
        help="Directory to write tokenizer.json, latest.pt, best.pt, and metrics.",
    )
    parser.add_argument(
        "--prompt",
        default="",
        help="Optional prompt to run quick local inference test after training completes.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    print("=" * 72)
    print("PROJECT GENESIS — GENESIS CORE EXPERIMENTAL TRAINING PIPELINE")
    print("Notice: Experimental prototype. Trains from random init on local text only.")
    print("=" * 72)

    corpus_text, provenance = load_local_text_corpus(args.corpus)
    print(
        f"[Corpus] Loaded {provenance['file_count']} local file(s) "
        f"({provenance['total_chars']} chars, {provenance['total_bytes']} bytes)."
    )

    model_cfg = build_preset_config(args.preset, vocab_size=args.vocab_size)
    model_cfg = GenesisCoreConfig(
        vocab_size=args.vocab_size or model_cfg.vocab_size,
        context_length=args.context_length or model_cfg.context_length,
        d_model=args.d_model or model_cfg.d_model,
        n_heads=args.n_heads or model_cfg.n_heads,
        n_layers=args.n_layers or model_cfg.n_layers,
        dropout=model_cfg.dropout,
        bias=model_cfg.bias,
        tie_weights=model_cfg.tie_weights,
    )

    tokenizer = GenesisByteBPETokenizer()
    tok_stats = tokenizer.train(
        corpus_text,
        target_vocab_size=model_cfg.vocab_size,
        min_frequency=2,
    )
    print(
        f"[Tokenizer] Trained GenesisByteBPETokenizer: vocab_size={tokenizer.vocab_size}, "
        f"merges={tok_stats['num_merges']}."
    )

    all_tokens = tokenizer.encode(corpus_text)
    train_ids, val_ids = create_train_val_splits(all_tokens, val_split=args.val_split)
    effective_ctx = min(model_cfg.context_length, len(train_ids) - 1, len(val_ids) - 1)
    if effective_ctx < model_cfg.context_length:
        print(
            f"[Dataset] Note: Small corpus shortened effective sequence length to {effective_ctx} tokens."
        )

    batcher = TextSequenceBatcher(
        train_ids=train_ids,
        val_ids=val_ids,
        context_length=model_cfg.context_length,
        seed=args.seed,
    )
    print(f"[Dataset] Train tokens: {len(train_ids)} | Validation tokens: {len(val_ids)}")

    if not HAS_TORCH:
        print(
            "\n[ERROR] PyTorch is not installed in this Python environment.\n"
            "Install Windows/Linux CPU PyTorch locally:\n"
            "  pip install torch --index-url https://download.pytorch.org/whl/cpu"
        )
        return 1

    train_cfg = TrainingConfig(
        batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        max_steps=args.steps,
        learning_rate=args.lr,
        val_split=args.val_split,
        seed=args.seed,
        num_threads=args.threads,
        device="cpu",
        checkpoint_dir=args.checkpoint_dir,
    )

    model = GenesisCoreTransformer(model_cfg)
    print(
        f"[Model] Initialized GenesisCoreTransformer (UN-TRAINED): "
        f"params={model.count_parameters():,}, d_model={model_cfg.d_model}, "
        f"heads={model_cfg.n_heads}, layers={model_cfg.n_layers}, ctx={model_cfg.context_length}"
    )

    def log_progress(ev: dict[str, object]) -> None:
        val_part = f" | val_loss={ev['val_loss']}" if ev.get("val_loss") is not None else ""
        print(
            f"  step {ev['step']:>4}/{ev['max_steps']} | "
            f"train_loss={ev['train_loss']}{val_part} | "
            f"lr={ev['lr']} | {ev['tokens_per_sec']} tok/s"
        )

    trainer = GenesisCoreTrainer(
        model=model,
        tokenizer=tokenizer,
        batcher=batcher,
        model_config=model_cfg,
        train_config=train_cfg,
    )
    summary = trainer.train(on_progress=log_progress, corpus_provenance=provenance)

    print("\n[Training Complete — Experimental Prototype Checkpoint Saved]")
    print(f"  Latest Checkpoint : {summary['latest_checkpoint']}")
    print(f"  Best Checkpoint   : {summary['best_checkpoint']}")
    print(f"  Tokenizer Path    : {summary['tokenizer_path']}")
    print(f"  Final Train Loss  : {summary['final_train_loss']}")
    print(f"  Final Val Loss    : {summary['final_val_loss']}")

    if args.prompt.strip():
        runtime = GenesisCoreLocalInference.from_checkpoint(summary["latest_checkpoint"])
        sample = runtime.generate_text(args.prompt.strip(), max_new_tokens=48)
        print("\n[Post-Train Smoke Generation (Experimental)]")
        print(f"  Prompt : {args.prompt.strip()}")
        print(f"  Output : {sample['text']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
