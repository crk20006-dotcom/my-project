"""
Modular Decoder-Only Transformer Architecture for Genesis Core (PyTorch).

Uses:
- RMSNorm pre-normalization
- Causal Multi-Head Self-Attention with explicit triangular lookahead mask
- SwiGLU Feed-Forward Network
- Weight-tied token embedding / LM head (configurable)

NOTE: Safely handles environments where PyTorch is not yet installed by exposing
`HAS_TORCH = False` so pure-Python diagnostics and configuration checks still work.
"""

from __future__ import annotations

import math
from typing import Any

from genesis_core.config import GenesisCoreConfig

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    HAS_TORCH = True
except ImportError:  # pragma: no cover - verified explicitly in non-torch containers
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    HAS_TORCH = False


def _require_torch() -> None:
    if not HAS_TORCH:
        raise RuntimeError(
            "PyTorch is not installed in this Python environment. "
            "Install CPU PyTorch locally with: pip install torch --index-url https://download.pytorch.org/whl/cpu"
        )


if HAS_TORCH:

    class RMSNorm(nn.Module):
        def __init__(self, dim: int, eps: float = 1e-6) -> None:
            super().__init__()
            self.eps = eps
            self.weight = nn.Parameter(torch.ones(dim))

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            norm = x * torch.rsqrt(x.pow(2).mean(dim=-1, keepdim=True) + self.eps)
            return norm * self.weight

    class CausalSelfAttention(nn.Module):
        def __init__(self, config: GenesisCoreConfig) -> None:
            super().__init__()
            self.n_heads = config.n_heads
            self.d_model = config.d_model
            self.head_dim = config.head_dim
            self.context_length = config.context_length

            self.qkv_proj = nn.Linear(config.d_model, 3 * config.d_model, bias=config.bias)
            self.out_proj = nn.Linear(config.d_model, config.d_model, bias=config.bias)
            self.attn_dropout = nn.Dropout(config.dropout)
            self.resid_dropout = nn.Dropout(config.dropout)

            causal_mask = torch.tril(
                torch.ones(config.context_length, config.context_length, dtype=torch.bool)
            ).view(1, 1, config.context_length, config.context_length)
            self.register_buffer("causal_mask", causal_mask, persistent=False)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            bsz, seq_len, dim = x.shape
            if seq_len > self.context_length:
                raise ValueError(
                    f"Sequence length {seq_len} exceeds model context_length {self.context_length}."
                )

            qkv = self.qkv_proj(x)
            q, k, v = qkv.split(self.d_model, dim=-1)

            q = q.view(bsz, seq_len, self.n_heads, self.head_dim).transpose(1, 2)
            k = k.view(bsz, seq_len, self.n_heads, self.head_dim).transpose(1, 2)
            v = v.view(bsz, seq_len, self.n_heads, self.head_dim).transpose(1, 2)

            scale = 1.0 / math.sqrt(self.head_dim)
            scores = (q @ k.transpose(-2, -1)) * scale
            mask = self.causal_mask[:, :, :seq_len, :seq_len]
            scores = scores.masked_fill(~mask, float("-inf"))

            probs = F.softmax(scores, dim=-1)
            probs = self.attn_dropout(probs)
            out = (probs @ v).transpose(1, 2).contiguous().view(bsz, seq_len, dim)
            return self.resid_dropout(self.out_proj(out))

    class SwiGLUFeedForward(nn.Module):
        def __init__(self, config: GenesisCoreConfig) -> None:
            super().__init__()
            hidden_dim = config.resolved_d_ff
            self.w1 = nn.Linear(config.d_model, hidden_dim, bias=config.bias)
            self.w3 = nn.Linear(config.d_model, hidden_dim, bias=config.bias)
            self.w2 = nn.Linear(hidden_dim, config.d_model, bias=config.bias)
            self.dropout = nn.Dropout(config.dropout)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            gated = F.silu(self.w1(x)) * self.w3(x)
            return self.dropout(self.w2(gated))

    class TransformerBlock(nn.Module):
        def __init__(self, config: GenesisCoreConfig) -> None:
            super().__init__()
            self.norm_1 = RMSNorm(config.d_model)
            self.attn = CausalSelfAttention(config)
            self.norm_2 = RMSNorm(config.d_model)
            self.ffn = SwiGLUFeedForward(config)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            x = x + self.attn(self.norm_1(x))
            x = x + self.ffn(self.norm_2(x))
            return x

    class GenesisCoreTransformer(nn.Module):
        """
        From-scratch experimental decoder-only Transformer for Project Genesis.
        Never contains pretrained weights upon initialization.
        """

        def __init__(self, config: GenesisCoreConfig) -> None:
            super().__init__()
            self.config = config
            self.token_embedding = nn.Embedding(config.vocab_size, config.d_model)
            self.pos_embedding = nn.Embedding(config.context_length, config.d_model)
            self.drop = nn.Dropout(config.dropout)
            self.blocks = nn.ModuleList(
                [TransformerBlock(config) for _ in range(config.n_layers)]
            )
            self.norm_f = RMSNorm(config.d_model)
            self.lm_head = nn.Linear(config.d_model, config.vocab_size, bias=False)

            if config.tie_weights:
                self.lm_head.weight = self.token_embedding.weight

            self.apply(self._init_weights)

        def _init_weights(self, module: nn.Module) -> None:
            if isinstance(module, nn.Linear):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.Embedding):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)

        def count_parameters(self, trainable_only: bool = True) -> int:
            if trainable_only:
                return sum(p.numel() for p in self.parameters() if p.requires_grad)
            return sum(p.numel() for p in self.parameters())

        def forward(
            self,
            idx: torch.Tensor,
            targets: torch.Tensor | None = None,
        ) -> tuple[torch.Tensor, torch.Tensor | None]:
            bsz, seq_len = idx.shape
            if seq_len > self.config.context_length:
                raise ValueError(
                    f"Input length {seq_len} exceeds configured context_length {self.config.context_length}."
                )

            positions = torch.arange(0, seq_len, dtype=torch.long, device=idx.device)
            x = self.token_embedding(idx) + self.pos_embedding(positions)
            x = self.drop(x)

            for block in self.blocks:
                x = block(x)

            x = self.norm_f(x)
            logits = self.lm_head(x)

            loss = None
            if targets is not None:
                loss = F.cross_entropy(
                    logits.reshape(-1, logits.size(-1)),
                    targets.reshape(-1),
                    ignore_index=-100,
                )
            return logits, loss

        @torch.no_grad()
        def generate(
            self,
            idx: torch.Tensor,
            max_new_tokens: int = 64,
            temperature: float = 0.8,
            top_k: int | None = 40,
            eos_token_id: int | None = None,
        ) -> torch.Tensor:
            was_training = self.training
            self.eval()
            try:
                for _ in range(max(1, max_new_tokens)):
                    idx_cond = idx[:, -self.config.context_length :]
                    logits, _ = self(idx_cond)
                    next_logits = logits[:, -1, :]

                    if temperature <= 0:
                        next_token = torch.argmax(next_logits, dim=-1, keepdim=True)
                    else:
                        scaled = next_logits / float(temperature)
                        if top_k is not None and top_k > 0:
                            k = min(top_k, scaled.size(-1))
                            vals, _ = torch.topk(scaled, k)
                            cutoff = vals[:, [-1]]
                            scaled = scaled.masked_fill(scaled < cutoff, float("-inf"))
                        probs = F.softmax(scaled, dim=-1)
                        next_token = torch.multinomial(probs, num_samples=1)

                    idx = torch.cat((idx, next_token), dim=1)
                    if eos_token_id is not None and idx.size(0) == 1:
                        if int(next_token.item()) == eos_token_id:
                            break
                return idx
            finally:
                if was_training:
                    self.train()

else:

    class GenesisCoreTransformer:  # type: ignore[no-redef]
        """Diagnostic stub when PyTorch is not installed."""

        def __init__(self, config: GenesisCoreConfig) -> None:
            _require_torch()

        def __getattr__(self, name: str) -> Any:
            _require_torch()
