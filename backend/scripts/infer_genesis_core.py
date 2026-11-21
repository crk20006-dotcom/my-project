"""
Local CPU-First Inference Script for Experimental Genesis Core Checkpoints.

Usage example (Windows PowerShell / CMD / Linux):
  python backend/scripts/infer_genesis_core.py --checkpoint ./data/checkpoints/genesis_core/latest.pt --prompt "Project Genesis"

Important:
- Loads only locally trained checkpoints from disk (never downloads pretrained weights).
- Refuses to fabricate text when no trained checkpoint exists or PyTorch is missing.
- Clearly tags outputs as experimental.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from genesis_core.checkpoint import HAS_TORCH, inspect_checkpoint_metadata
from genesis_core.inference import GenesisCoreLocalInference


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run local CPU inference on a trained experimental Genesis Core checkpoint."
    )
    parser.add_argument(
        "--checkpoint",
        default="./data/checkpoints/genesis_core/latest.pt",
        help="Path to local Genesis Core .pt checkpoint (default: ./data/checkpoints/genesis_core/latest.pt).",
    )
    parser.add_argument(
        "--tokenizer",
        default=None,
        help="Optional path to tokenizer.json (defaults to sidecar tokenizer recorded in checkpoint).",
    )
    parser.add_argument(
        "--prompt",
        required=True,
        help="Input prompt text to encode and continue.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=64,
        help="Maximum new tokens to generate (default: 64).",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.8,
        help="Sampling temperature; use 0 for greedy decoding (default: 0.8).",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=40,
        help="Top-k sampling cutoff (default: 40).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    meta = inspect_checkpoint_metadata(args.checkpoint)

    print("=" * 72)
    print("PROJECT GENESIS — GENESIS CORE LOCAL INFERENCE (EXPERIMENTAL)")
    print("=" * 72)

    if not meta["checkpoint_exists"]:
        print(
            f"[Untrained / Not Found] No trained checkpoint exists at: {meta['checkpoint_path']}\n"
            "Train a small local model first with:\n"
            "  python backend/scripts/train_genesis_core.py --corpus ./docs --preset cpu_nano --steps 100"
        )
        return 1

    if not HAS_TORCH:
        print(
            f"[PyTorch Required] Checkpoint found (trained_steps={meta['trained_steps']}), "
            "but PyTorch is not installed in this Python runtime.\n"
            "Install CPU PyTorch locally with:\n"
            "  pip install torch --index-url https://download.pytorch.org/whl/cpu"
        )
        return 1

    runtime = GenesisCoreLocalInference.from_checkpoint(
        args.checkpoint,
        tokenizer_path=args.tokenizer,
        device="cpu",
    )
    result = runtime.generate_text(
        prompt=args.prompt,
        max_new_tokens=args.max_tokens,
        temperature=args.temperature,
        top_k=args.top_k,
    )

    if not result["ok"]:
        print(f"[Inference Halted] {result['error']}")
        return 1

    print(
        f"[Status] Experimental Prototype | trained_steps={result['trained_steps']} | "
        f"finish_reason={result['finish_reason']} | "
        f"tokens={result['usage']['prompt_tokens']}->{result['usage']['completion_tokens']}"
    )
    print("-" * 72)
    print(result["text"])
    print("-" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
