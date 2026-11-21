"""
Genesis Core — Experimental Independent Foundation Model Package.

This package contains our own from-scratch decoder-only Transformer architecture,
trainable byte-level BPE tokenizer, local text dataset loader, CPU-first training loop,
checkpoint management, and local inference runtime.

IMPORTANT:
- No external AI APIs are used.
- No pretrained weights are downloaded.
- All models start completely untrained and must be explicitly labeled as experimental.
"""

from genesis_core.config import GenesisCoreConfig, TrainingConfig
from genesis_core.tokenizer import BaseGenesisTokenizer, GenesisByteBPETokenizer
from genesis_core.dataset import (
    ALLOWED_CORPUS_EXTENSIONS,
    TextSequenceBatcher,
    create_train_val_splits,
    load_local_text_corpus,
    preprocess_corpus_text,
)
from genesis_core.checkpoint import (
    HAS_TORCH,
    inspect_checkpoint_metadata,
    load_checkpoint,
    save_checkpoint,
)
from genesis_core.model import GenesisCoreTransformer
from genesis_core.trainer import GenesisCoreTrainer
from genesis_core.inference import GenesisCoreLocalInference

__all__ = [
    "ALLOWED_CORPUS_EXTENSIONS",
    "BaseGenesisTokenizer",
    "GenesisByteBPETokenizer",
    "GenesisCoreConfig",
    "GenesisCoreLocalInference",
    "GenesisCoreTrainer",
    "GenesisCoreTransformer",
    "HAS_TORCH",
    "TextSequenceBatcher",
    "TrainingConfig",
    "create_train_val_splits",
    "inspect_checkpoint_metadata",
    "load_checkpoint",
    "load_local_text_corpus",
    "preprocess_corpus_text",
    "save_checkpoint",
]
