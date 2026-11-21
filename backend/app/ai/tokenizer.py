import re
from typing import Any
from app.ai.interfaces import BaseTokenizer


class BaselineTokenizer(BaseTokenizer):
    """Deterministic baseline tokenizer for Step 01 local diagnostics and context budgeting."""

    _SEGMENT_RE = re.compile(r"(\s+|[A-Za-z0-9]+|[^\sA-Za-z0-9]+)")

    @staticmethod
    def _fnv1a_token_id(segment: str) -> int:
        h = 2166136261
        for ch in segment:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        return h % 65536

    def _segment(self, text: str) -> list[str]:
        segments = self._SEGMENT_RE.findall(text)
        tokens: list[str] = []
        for seg in segments:
            if seg.isspace() or len(seg) <= 5:
                tokens.append(seg)
            else:
                for i in range(0, len(seg), 4):
                    tokens.append(seg[i : i + 4])
        return tokens

    def encode(self, text: str) -> list[int]:
        return [self._fnv1a_token_id(t) for t in self._segment(text)]

    def decode(self, ids: list[int]) -> str:
        return " ".join(f"<tok:{i}>" for i in ids)

    def inspect(self, text: str, context_limit: int = 8192) -> dict[str, Any]:
        if not text:
            return {
                "token_count": 0,
                "char_count": 0,
                "byte_count": 0,
                "word_count": 0,
                "estimated_context_pct": 0.0,
                "tokens": [],
            }

        segments = self._segment(text)
        tokens = [
            {
                "index": idx,
                "text": seg,
                "bytes": len(seg.encode("utf-8")),
                "id": self._fnv1a_token_id(seg),
            }
            for idx, seg in enumerate(segments[:240])
        ]
        return {
            "token_count": len(segments),
            "char_count": len(text),
            "byte_count": len(text.encode("utf-8")),
            "word_count": len(text.strip().split()) if text.strip() else 0,
            "estimated_context_pct": min(100.0, round((len(segments) / max(1, context_limit)) * 100, 2)),
            "tokens": tokens,
        }
