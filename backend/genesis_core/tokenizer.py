"""
Independent Tokenizer Interface & Trainable Byte-Level BPE Tokenizer for Genesis Core.

Implements:
- BaseGenesisTokenizer: standard contract compatible with training, inference, and Laboratory diagnostics.
- GenesisByteBPETokenizer: pure-Python UTF-8 byte-fallback BPE tokenizer that starts with
  4 special tokens + 256 byte tokens (vocab=260) and learns BPE merge rules from local text datasets.
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SPECIAL_TOKENS: list[str] = ["<pad>", "<unk>", "<bos>", "<eos>"]
PAD_TOKEN_ID = 0
UNK_TOKEN_ID = 1
BOS_TOKEN_ID = 2
EOS_TOKEN_ID = 3
BYTE_OFFSET = len(SPECIAL_TOKENS)  # 4 -> byte 0..255 maps to IDs 4..259
BASE_VOCAB_SIZE = BYTE_OFFSET + 256  # 260

# Splits text into whitespace runs, alphanumeric/underscore words, or individual symbols
PRETOKENIZE_RE = re.compile(r"\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+", re.UNICODE)


class BaseGenesisTokenizer(ABC):
    """Abstract tokenizer contract for Project Genesis."""

    @property
    @abstractmethod
    def vocab_size(self) -> int: ...

    @abstractmethod
    def encode(self, text: str, add_bos: bool = False, add_eos: bool = False) -> list[int]: ...

    @abstractmethod
    def decode(self, ids: list[int], skip_special_tokens: bool = True) -> str: ...

    @abstractmethod
    def inspect(self, text: str, context_limit: int = 128) -> dict[str, Any]: ...


class GenesisByteBPETokenizer(BaseGenesisTokenizer):
    """
    Lossless UTF-8 Byte-Fallback BPE Tokenizer implemented purely in Python standard library.

    - Special tokens: <pad>=0, <unk>=1, <bos>=2, <eos>=3
    - Byte tokens: IDs 4..259 correspond to raw bytes 0x00..0xFF
    - Merged BPE tokens: IDs >= 260 learned deterministically via `train(...)`
    """

    def __init__(self) -> None:
        self.special_tokens: dict[str, int] = {
            tok: idx for idx, tok in enumerate(SPECIAL_TOKENS)
        }
        self.id_to_bytes: dict[int, bytes] = {
            BYTE_OFFSET + b: bytes([b]) for b in range(256)
        }
        # Merges stored in exact training priority order: [((id_a, id_b), new_id), ...]
        self.merges: list[tuple[tuple[int, int], int]] = []
        self._merge_ranks: dict[tuple[int, int], tuple[int, int]] = {}
        self.trained: bool = False
        self.training_meta: dict[str, Any] = {
            "trained": False,
            "num_merges": 0,
            "corpus_chars": 0,
            "corpus_bytes": 0,
            "trained_at": None,
        }

    @property
    def vocab_size(self) -> int:
        return BASE_VOCAB_SIZE + len(self.merges)

    @property
    def pad_token_id(self) -> int:
        return PAD_TOKEN_ID

    @property
    def unk_token_id(self) -> int:
        return UNK_TOKEN_ID

    @property
    def bos_token_id(self) -> int:
        return BOS_TOKEN_ID

    @property
    def eos_token_id(self) -> int:
        return EOS_TOKEN_ID

    def train(
        self,
        texts: str | list[str],
        target_vocab_size: int = 512,
        min_frequency: int = 2,
    ) -> dict[str, Any]:
        """
        Train BPE merge rules strictly on the provided local text dataset.
        """
        if target_vocab_size < BASE_VOCAB_SIZE:
            raise ValueError(
                f"target_vocab_size ({target_vocab_size}) must be >= {BASE_VOCAB_SIZE}."
            )
        if min_frequency < 1:
            raise ValueError("min_frequency must be >= 1.")

        corpus = texts if isinstance(texts, str) else "\n".join(texts)
        if not corpus:
            raise ValueError("Cannot train tokenizer on empty corpus.")

        # Reset learned state prior to training
        self.id_to_bytes = {BYTE_OFFSET + b: bytes([b]) for b in range(256)}
        self.merges = []
        self._merge_ranks = {}

        # Count unique pre-tokenized chunks for fast pure-Python BPE training
        chunk_counts: Counter[tuple[int, ...]] = Counter()
        for match in PRETOKENIZE_RE.finditer(corpus):
            raw = match.group(0).encode("utf-8")
            if raw:
                chunk_counts[tuple(BYTE_OFFSET + b for b in raw)] += 1

        max_merges = target_vocab_size - BASE_VOCAB_SIZE
        # Represent distinct chunks with their corpus frequencies
        sequences: list[tuple[list[int], int]] = [
            (list(seq), freq) for seq, freq in chunk_counts.items()
        ]

        next_id = BASE_VOCAB_SIZE
        for merge_rank in range(max_merges):
            pair_freqs: Counter[tuple[int, int]] = Counter()
            for seq, freq in sequences:
                if len(seq) < 2:
                    continue
                for i in range(len(seq) - 1):
                    pair_freqs[(seq[i], seq[i + 1])] += freq

            if not pair_freqs:
                break

            # Deterministic tie-break: highest count first, then lexicographically smallest pair
            best_pair, best_freq = min(
                pair_freqs.items(),
                key=lambda kv: (-kv[1], kv[0]),
            )
            if best_freq < min_frequency:
                break

            new_token_bytes = self.id_to_bytes[best_pair[0]] + self.id_to_bytes[best_pair[1]]
            self.id_to_bytes[next_id] = new_token_bytes
            self.merges.append((best_pair, next_id))
            self._merge_ranks[best_pair] = (merge_rank, next_id)

            # Apply merge across unique sequences
            a, b = best_pair
            updated_sequences: list[tuple[list[int], int]] = []
            for seq, freq in sequences:
                if len(seq) < 2:
                    updated_sequences.append((seq, freq))
                    continue
                merged: list[int] = []
                i = 0
                n = len(seq)
                while i < n:
                    if i + 1 < n and seq[i] == a and seq[i + 1] == b:
                        merged.append(next_id)
                        i += 2
                    else:
                        merged.append(seq[i])
                        i += 1
                updated_sequences.append((merged, freq))
            sequences = updated_sequences
            next_id += 1

        self.trained = len(self.merges) > 0
        self.training_meta = {
            "trained": self.trained,
            "vocab_size": self.vocab_size,
            "num_merges": len(self.merges),
            "corpus_chars": len(corpus),
            "corpus_bytes": len(corpus.encode("utf-8")),
            "min_frequency": min_frequency,
            "trained_at": datetime.now(timezone.utc).isoformat(),
        }
        return dict(self.training_meta)

    def _encode_chunk(self, chunk_bytes: bytes) -> list[int]:
        ids = [BYTE_OFFSET + b for b in chunk_bytes]
        if len(ids) < 2 or not self._merge_ranks:
            return ids

        while len(ids) >= 2:
            best_rank: int | None = None
            best_pair: tuple[int, int] | None = None
            best_new_id = -1

            for i in range(len(ids) - 1):
                pair = (ids[i], ids[i + 1])
                info = self._merge_ranks.get(pair)
                if info is not None:
                    rank, new_id = info
                    if best_rank is None or rank < best_rank:
                        best_rank = rank
                        best_pair = pair
                        best_new_id = new_id

            if best_pair is None:
                break

            a, b = best_pair
            merged: list[int] = []
            i = 0
            n = len(ids)
            while i < n:
                if i + 1 < n and ids[i] == a and ids[i + 1] == b:
                    merged.append(best_new_id)
                    i += 2
                else:
                    merged.append(ids[i])
                    i += 1
            ids = merged

        return ids

    def encode(self, text: str, add_bos: bool = False, add_eos: bool = False) -> list[int]:
        tokens: list[int] = []
        if add_bos:
            tokens.append(BOS_TOKEN_ID)
        if text:
            for match in PRETOKENIZE_RE.finditer(text):
                raw = match.group(0).encode("utf-8")
                if raw:
                    tokens.extend(self._encode_chunk(raw))
        if add_eos:
            tokens.append(EOS_TOKEN_ID)
        return tokens

    def decode(self, ids: list[int], skip_special_tokens: bool = True) -> str:
        byte_chunks: list[bytes] = []
        reverse_special = {idx: tok for tok, idx in self.special_tokens.items()}
        for token_id in ids:
            if token_id in reverse_special:
                if not skip_special_tokens:
                    byte_chunks.append(reverse_special[token_id].encode("utf-8"))
                continue
            piece = self.id_to_bytes.get(token_id)
            if piece is not None:
                byte_chunks.append(piece)
        return b"".join(byte_chunks).decode("utf-8", errors="replace")

    def inspect(self, text: str, context_limit: int = 128) -> dict[str, Any]:
        encoded = self.encode(text)
        byte_count = len(text.encode("utf-8")) if text else 0
        words = len(text.strip().split()) if text and text.strip() else 0
        limit = max(1, context_limit)
        tokens_preview = []
        for idx, tid in enumerate(encoded[:240]):
            raw_bytes = self.id_to_bytes.get(tid, b"")
            tokens_preview.append(
                {
                    "index": idx,
                    "text": raw_bytes.decode("utf-8", errors="replace"),
                    "bytes": len(raw_bytes),
                    "id": tid,
                }
            )
        return {
            "tokenizer": "GenesisByteBPETokenizer",
            "trained": self.trained,
            "vocab_size": self.vocab_size,
            "token_count": len(encoded),
            "char_count": len(text or ""),
            "byte_count": byte_count,
            "word_count": words,
            "estimated_context_pct": round(min(100.0, (len(encoded) / limit) * 100.0), 2),
            "tokens": tokens_preview,
        }

    def save(self, path: str | Path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "format": "genesis_byte_bpe_v1",
            "special_tokens": self.special_tokens,
            "vocab_size": self.vocab_size,
            "trained": self.trained,
            "training_meta": self.training_meta,
            "merges": [[a, b, new_id] for (a, b), new_id in self.merges],
        }
        target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return target

    @classmethod
    def load(cls, path: str | Path) -> GenesisByteBPETokenizer:
        source = Path(path)
        data = json.loads(source.read_text(encoding="utf-8"))
        if data.get("format") != "genesis_byte_bpe_v1":
            raise ValueError(f"Unsupported tokenizer format in {source}.")

        tok = cls()
        for rank, entry in enumerate(data.get("merges", [])):
            a, b, new_id = int(entry[0]), int(entry[1]), int(entry[2])
            tok.id_to_bytes[new_id] = tok.id_to_bytes[a] + tok.id_to_bytes[b]
            pair = (a, b)
            tok.merges.append((pair, new_id))
            tok._merge_ranks[pair] = (rank, new_id)

        tok.trained = bool(data.get("trained", len(tok.merges) > 0))
        tok.training_meta = dict(data.get("training_meta") or {})
        return tok
