"""
Configuration dataclasses and CPU-first Windows presets for Genesis Core.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class GenesisCoreConfig:
    """
    Architecture configuration for the experimental Genesis Core decoder-only Transformer.
    Default preset targets low-RAM CPU experimentation on Windows (8-16 GB RAM).
    """

    vocab_size: int = 512
    context_length: int = 128
    d_model: int = 128
    n_heads: int = 4
    n_layers: int = 4
    d_ff: int | None = None
    dropout: float = 0.1
    bias: bool = False
    tie_weights: bool = True
    experimental: bool = True
    model_status: str = "untrained_experimental"

    def __post_init__(self) -> None:
        if self.vocab_size < 260:
            raise ValueError(
                "vocab_size must be at least 260 (4 special tokens + 256 lossless UTF-8 byte tokens)."
            )
        if self.context_length < 8:
            raise ValueError("context_length must be at least 8 tokens.")
        if self.d_model < 16:
            raise ValueError("d_model must be at least 16.")
        if self.n_heads < 1:
            raise ValueError("n_heads must be >= 1.")
        if self.d_model % self.n_heads != 0:
            raise ValueError(
                f"d_model ({self.d_model}) must be divisible by n_heads ({self.n_heads})."
            )
        if self.n_layers < 1:
            raise ValueError("n_layers must be >= 1.")
        if not (0.0 <= self.dropout < 1.0):
            raise ValueError("dropout must be in [0.0, 1.0).")

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads

    @property
    def resolved_d_ff(self) -> int:
        if self.d_ff is not None and self.d_ff > 0:
            return self.d_ff
        # Rounded multiple of 32 for clean CPU cache/vectorization behavior (~2.67x-4x)
        raw = int((self.d_model * 8) / 3)
        return max(32, ((raw + 31) // 32) * 32)

    def estimate_parameter_count(self) -> int:
        """Estimate trainable parameter count purely in Python (no PyTorch required)."""
        d_ff = self.resolved_d_ff
        tok_emb = self.vocab_size * self.d_model
        pos_emb = self.context_length * self.d_model
        # Per transformer block: qkv_proj (d_model -> 3*d_model) + out_proj (d_model -> d_model)
        # + SwiGLU FFN (w1, w3: d_model -> d_ff; w2: d_ff -> d_model) + 2x RMSNorm (2*d_model)
        attn_params = 4 * self.d_model * self.d_model
        ffn_params = 3 * self.d_model * d_ff
        norm_params = 2 * self.d_model
        per_block = attn_params + ffn_params + norm_params
        final_norm = self.d_model
        lm_head = 0 if self.tie_weights else (self.vocab_size * self.d_model)
        return tok_emb + pos_emb + (self.n_layers * per_block) + final_norm + lm_head

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["resolved_d_ff"] = self.resolved_d_ff
        data["head_dim"] = self.head_dim
        data["estimated_parameters"] = self.estimate_parameter_count()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GenesisCoreConfig:
        valid_fields = {
            "vocab_size",
            "context_length",
            "d_model",
            "n_heads",
            "n_layers",
            "d_ff",
            "dropout",
            "bias",
            "tie_weights",
            "experimental",
            "model_status",
        }
        filtered = {k: v for k, v in data.items() if k in valid_fields}
        return cls(**filtered)

    @classmethod
    def cpu_nano(cls, vocab_size: int = 512) -> GenesisCoreConfig:
        """~0.45M params · Fast CPU smoke testing on 8 GB Windows laptops."""
        return cls(
            vocab_size=vocab_size,
            context_length=64,
            d_model=64,
            n_heads=4,
            n_layers=2,
            dropout=0.05,
        )

    @classmethod
    def cpu_micro(cls, vocab_size: int = 1024) -> GenesisCoreConfig:
        """~1.1M params · Balanced default for local CPU experimentation."""
        return cls(
            vocab_size=vocab_size,
            context_length=128,
            d_model=128,
            n_heads=4,
            n_layers=4,
            dropout=0.1,
        )

    @classmethod
    def cpu_small(cls, vocab_size: int = 2048) -> GenesisCoreConfig:
        """~6.5M params · Larger CPU experiment (16 GB RAM recommended)."""
        return cls(
            vocab_size=vocab_size,
            context_length=256,
            d_model=256,
            n_heads=8,
            n_layers=6,
            dropout=0.1,
        )


@dataclass
class TrainingConfig:
    """
    CPU-first training configuration suitable for Windows machines with limited RAM.
    """

    batch_size: int = 4
    gradient_accumulation_steps: int = 4
    max_steps: int = 100
    learning_rate: float = 3e-4
    min_lr: float = 3e-5
    weight_decay: float = 0.01
    grad_clip: float = 1.0
    warmup_steps: int = 10
    eval_interval: int = 25
    eval_batches: int = 8
    save_interval: int = 50
    val_split: float = 0.1
    seed: int = 42
    num_threads: int = 4
    device: str = "cpu"
    checkpoint_dir: str = "./data/checkpoints/genesis_core"

    def __post_init__(self) -> None:
        if self.batch_size < 1:
            raise ValueError("batch_size must be >= 1.")
        if self.gradient_accumulation_steps < 1:
            raise ValueError("gradient_accumulation_steps must be >= 1.")
        if self.max_steps < 1:
            raise ValueError("max_steps must be >= 1.")
        if not (0.0 < self.val_split < 0.5):
            raise ValueError("val_split must be strictly between 0.0 and 0.5.")
        if self.num_threads < 1:
            raise ValueError("num_threads must be >= 1.")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TrainingConfig:
        valid_fields = set(cls.__dataclass_fields__.keys())
        return cls(**{k: v for k, v in data.items() if k in valid_fields})


PRESET_FACTORY = {
    "cpu_nano": GenesisCoreConfig.cpu_nano,
    "cpu_micro": GenesisCoreConfig.cpu_micro,
    "cpu_small": GenesisCoreConfig.cpu_small,
}


def build_preset_config(preset_name: str, vocab_size: int | None = None) -> GenesisCoreConfig:
    key = preset_name.strip().lower()
    if key not in PRESET_FACTORY:
        raise ValueError(
            f"Unknown preset '{preset_name}'. Choose from: {', '.join(sorted(PRESET_FACTORY))}."
        )
    cfg = PRESET_FACTORY[key]()
    if vocab_size is not None:
        cfg = GenesisCoreConfig(
            vocab_size=vocab_size,
            context_length=cfg.context_length,
            d_model=cfg.d_model,
            n_heads=cfg.n_heads,
            n_layers=cfg.n_layers,
            d_ff=cfg.d_ff,
            dropout=cfg.dropout,
            bias=cfg.bias,
            tie_weights=cfg.tie_weights,
        )
    return cfg
