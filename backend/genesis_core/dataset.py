"""
Local Text Dataset Loading, Validation Splitting & Sequence Batching for Genesis Core.

Strictly loads legally sourced local filesystem text datasets (never fetches remote URLs).
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

try:
    import torch

    HAS_TORCH = True
except ImportError:  # pragma: no cover
    torch = None  # type: ignore[assignment]
    HAS_TORCH = False


ALLOWED_CORPUS_EXTENSIONS: set[str] = {".txt", ".md", ".py", ".json", ".csv", ".log"}


def preprocess_corpus_text(
    raw_text: str,
    normalize_line_endings: bool = True,
    collapse_blank_lines: bool = True,
) -> str:
    """
    Clean local text before tokenization:
    - Strip NUL bytes
    - Normalize Windows CRLF/CR line endings to LF
    - Collapse 3+ consecutive newlines into double-newline paragraph breaks
    """
    if not raw_text:
        return ""
    cleaned = raw_text.replace("\x00", "")
    if normalize_line_endings:
        cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    if collapse_blank_lines:
        lines = [line.rstrip() for line in cleaned.split("\n")]
        collapsed: list[str] = []
        blank_run = 0
        for line in lines:
            if line == "":
                blank_run += 1
                if blank_run <= 2:
                    collapsed.append(line)
            else:
                blank_run = 0
                collapsed.append(line)
        cleaned = "\n".join(collapsed)
    return cleaned.strip()


def load_local_text_corpus(
    paths: str | Path | list[str | Path],
    allowed_extensions: set[str] | None = None,
    max_file_bytes: int = 10 * 1024 * 1024,
) -> tuple[str, dict[str, Any]]:
    """
    Load text from one or more local files or directories.
    Explicitly blocks URLs (`http://`, `https://`) so only local datasets are ingested.
    """
    exts = {e.lower() for e in (allowed_extensions or ALLOWED_CORPUS_EXTENSIONS)}
    raw_list = paths if isinstance(paths, list) else [paths]
    if not raw_list:
        raise ValueError("At least one local file or directory path must be provided.")

    collected_files: list[Path] = []
    seen_resolved: set[Path] = set()

    for raw in raw_list:
        raw_str = str(raw).strip()
        lowered = raw_str.lower()
        if lowered.startswith(("http://", "https://", "ftp://", "s3://", "hf://")):
            raise ValueError(
                f"Remote dataset URL '{raw_str}' is forbidden. Provide local text files only."
            )

        p = Path(raw_str).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"Local dataset path not found: {p}")

        if p.is_file():
            if p.suffix.lower() not in exts:
                raise ValueError(
                    f"Unsupported dataset extension '{p.suffix}' for file {p.name}. Allowed: {sorted(exts)}"
                )
            if p not in seen_resolved:
                seen_resolved.add(p)
                collected_files.append(p)
        elif p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and child.suffix.lower() in exts:
                    resolved = child.resolve()
                    if resolved not in seen_resolved:
                        seen_resolved.add(resolved)
                        collected_files.append(resolved)

    if not collected_files:
        raise ValueError("No readable local text files matched allowed corpus extensions.")

    chunks: list[str] = []
    ingested_files: list[str] = []
    total_bytes = 0

    for file_path in collected_files:
        size = file_path.stat().st_size
        if size == 0:
            continue
        if size > max_file_bytes:
            raise ValueError(
                f"Dataset file {file_path.name} ({size} bytes) exceeds max_file_bytes ({max_file_bytes})."
            )
        raw_read = file_path.read_text(encoding="utf-8", errors="replace")
        text = preprocess_corpus_text(raw_read)
        if text:
            chunks.append(text)
            ingested_files.append(str(file_path))
            total_bytes += size

    combined = "\n\n".join(chunks)
    if not combined:
        raise ValueError("Loaded local dataset files contain no non-empty text.")

    provenance = {
        "source_type": "local_filesystem",
        "file_count": len(ingested_files),
        "files": ingested_files,
        "total_bytes": total_bytes,
        "total_chars": len(combined),
    }
    return combined, provenance


def create_train_val_splits(
    token_ids: list[int],
    val_split: float = 0.1,
    min_seq_len: int = 9,
) -> tuple[list[int], list[int]]:
    """
    Deterministically partition tokenized sequence into contiguous train and validation splits.
    """
    if not (0.0 < val_split < 0.5):
        raise ValueError("val_split must be strictly between 0.0 and 0.5.")
    n = len(token_ids)
    if n < min_seq_len * 2:
        raise ValueError(
            f"Corpus too small ({n} tokens) for train/val split with min_seq_len={min_seq_len}."
        )

    split_idx = int(n * (1.0 - val_split))
    split_idx = max(min_seq_len, min(n - min_seq_len, split_idx))
    return token_ids[:split_idx], token_ids[split_idx:]


class TextSequenceBatcher:
    """
    Samples autoregressive next-token training batches `(x, y)` where `y[t] = x[t+1]`.
    Works both in pure Python (`sample_sequences`) and as PyTorch tensors (`get_torch_batch`).
    """

    def __init__(
        self,
        train_ids: list[int],
        val_ids: list[int],
        context_length: int,
        seed: int = 42,
    ) -> None:
        if context_length < 2:
            raise ValueError("context_length must be >= 2.")
        if len(train_ids) < 3 or len(val_ids) < 3:
            raise ValueError("Both train_ids and val_ids must contain at least 3 tokens.")

        self.train_ids = train_ids
        self.val_ids = val_ids
        self.context_length = context_length
        self._rng = random.Random(seed)

    def effective_seq_len(self, split: str) -> int:
        data = self.train_ids if split == "train" else self.val_ids
        return min(self.context_length, len(data) - 1)

    def sample_sequences(
        self,
        split: str,
        batch_size: int,
    ) -> tuple[list[list[int]], list[list[int]]]:
        if split not in {"train", "val"}:
            raise ValueError("split must be 'train' or 'val'.")
        data = self.train_ids if split == "train" else self.val_ids
        seq_len = min(self.context_length, len(data) - 1)
        max_start = len(data) - seq_len - 1

        xs: list[list[int]] = []
        ys: list[list[int]] = []
        for _ in range(batch_size):
            start = 0 if max_start <= 0 else self._rng.randint(0, max_start)
            xs.append(data[start : start + seq_len])
            ys.append(data[start + 1 : start + seq_len + 1])
        return xs, ys

    def get_torch_batch(self, split: str, batch_size: int, device: str = "cpu") -> tuple[Any, Any]:
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required to construct tensor batches.")
        xs, ys = self.sample_sequences(split, batch_size)
        x_tensor = torch.tensor(xs, dtype=torch.long, device=device)
        y_tensor = torch.tensor(ys, dtype=torch.long, device=device)
        return x_tensor, y_tensor
