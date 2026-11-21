"""
Reproducible Tests for Genesis Core Model Foundation (Step 05).

Includes:
- Pure-Python tests (always executed): configuration presets, Byte-BPE tokenizer training,
  UTF-8 lossless round-trip encode/decode & persistence, local corpus loader & SSRF URL guard,
  deterministic train/val splits, next-token batching `(x, y)` shift checks, checkpoint metadata
  inspection, untrained inference safety, and GenesisCorePlaceholderAdapter honest diagnostics.
- PyTorch tests (executed automatically whenever `torch` is installed; cleanly skipped with an
  explicit skip reason in torch-free preview containers): model forward shapes & loss, CPU-first
  training step, checkpoint `.pt` + `.meta.json` round-trip, and trained local inference.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from genesis_core.checkpoint import (
    HAS_TORCH,
    inspect_checkpoint_metadata,
    load_checkpoint,
    save_checkpoint,
)
from genesis_core.config import GenesisCoreConfig, TrainingConfig, build_preset_config
from genesis_core.dataset import (
    TextSequenceBatcher,
    create_train_val_splits,
    load_local_text_corpus,
    preprocess_corpus_text,
)
from genesis_core.inference import GenesisCoreLocalInference
from genesis_core.model import GenesisCoreTransformer
from genesis_core.tokenizer import GenesisByteBPETokenizer
from genesis_core.trainer import GenesisCoreTrainer


SAMPLE_LOCAL_TEXT = (
    "Project Genesis builds an independent AI foundation model architecture.\n"
    "Every module executes locally with deterministic verification and clear state.\n"
    "Tokenizer training merges frequent byte pairs from local text files.\n"
    "Decoder transformers predict the next token in a causal sequence.\n"
    "Validation splits track generalization loss without external AI APIs.\n"
) * 6


class GenesisCorePurePythonTests(unittest.TestCase):
    def test_config_presets_and_validation(self) -> None:
        nano = GenesisCoreConfig.cpu_nano()
        self.assertEqual(nano.d_model % nano.n_heads, 0)
        self.assertTrue(nano.experimental)
        self.assertEqual(nano.model_status, "untrained_experimental")
        self.assertGreater(nano.estimate_parameter_count(), 100_000)

        micro = build_preset_config("cpu_micro", vocab_size=600)
        self.assertEqual(micro.vocab_size, 600)
        self.assertEqual(micro.d_model, 128)

        with self.assertRaises(ValueError):
            GenesisCoreConfig(vocab_size=512, d_model=100, n_heads=8)

        with self.assertRaises(ValueError):
            GenesisCoreConfig(vocab_size=128)

    def test_byte_bpe_tokenizer_train_encode_decode_save_load(self) -> None:
        tok = GenesisByteBPETokenizer()
        self.assertFalse(tok.trained)
        self.assertEqual(tok.vocab_size, 260)

        meta = tok.train(SAMPLE_LOCAL_TEXT, target_vocab_size=320, min_frequency=2)
        self.assertTrue(tok.trained)
        self.assertGreater(meta["num_merges"], 0)
        self.assertGreater(tok.vocab_size, 260)
        self.assertLessEqual(tok.vocab_size, 320)

        # Round-trip UTF-8 text including punctuation, newlines, and non-ASCII
        test_phrase = "Genesis Core test: UTF-8 naïve αβγ {tokens} -> 100%!"
        encoded = tok.encode(test_phrase, add_bos=True, add_eos=True)
        self.assertEqual(encoded[0], tok.bos_token_id)
        self.assertEqual(encoded[-1], tok.eos_token_id)
        self.assertEqual(tok.decode(encoded, skip_special_tokens=True), test_phrase)

        inspection = tok.inspect(test_phrase, context_limit=64)
        self.assertTrue(inspection["trained"])
        self.assertEqual(inspection["token_count"], len(tok.encode(test_phrase)))

        with tempfile.TemporaryDirectory() as tmp:
            tok_file = Path(tmp) / "tokenizer.json"
            tok.save(tok_file)
            reloaded = GenesisByteBPETokenizer.load(tok_file)
            self.assertEqual(reloaded.vocab_size, tok.vocab_size)
            self.assertEqual(reloaded.encode(test_phrase), tok.encode(test_phrase))
            self.assertEqual(reloaded.decode(reloaded.encode(test_phrase)), test_phrase)

    def test_preprocessing_and_local_dataset_loader_splits_and_batching(self) -> None:
        dirty = "Line one\r\n\r\n\r\n\r\nLine two\x00   \rLine three  "
        cleaned = preprocess_corpus_text(dirty)
        self.assertEqual(cleaned, "Line one\n\n\nLine two\nLine three")

        with self.assertRaises(ValueError):
            load_local_text_corpus("https://example.com/corpus.txt")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            f1 = tmp_dir / "part1.txt"
            f2 = tmp_dir / "part2.md"
            ignored = tmp_dir / "binary.bin"
            f1.write_text(SAMPLE_LOCAL_TEXT, encoding="utf-8")
            f2.write_text("Markdown corpus notes for validation splitting.\n" * 8, encoding="utf-8")
            ignored.write_bytes(b"\x00\x01\x02")

            corpus, provenance = load_local_text_corpus(tmp_dir)
            self.assertEqual(provenance["file_count"], 2)
            self.assertEqual(provenance["source_type"], "local_filesystem")

            tok = GenesisByteBPETokenizer()
            tok.train(corpus, target_vocab_size=300, min_frequency=2)
            all_ids = tok.encode(corpus)

            train_ids, val_ids = create_train_val_splits(all_ids, val_split=0.15)
            self.assertEqual(len(train_ids) + len(val_ids), len(all_ids))
            self.assertGreater(len(train_ids), len(val_ids))

            batcher = TextSequenceBatcher(train_ids, val_ids, context_length=32, seed=7)
            xs, ys = batcher.sample_sequences("train", batch_size=3)
            self.assertEqual(len(xs), 3)
            self.assertEqual(len(ys), 3)
            for x_seq, y_seq in zip(xs, ys):
                self.assertEqual(len(x_seq), 32)
                self.assertEqual(len(y_seq), 32)
                # Next-token shift property: y[t] == x[t+1]
                self.assertEqual(x_seq[1:], y_seq[:-1])

    def test_untrained_inference_and_adapter_safety(self) -> None:
        # 1. Pure inference interface refuses to fabricate completions when untrained
        runtime = GenesisCoreLocalInference()
        status = runtime.status_summary()
        self.assertTrue(status["experimental"])
        self.assertFalse(status["is_trained"])
        self.assertEqual(status["model_status"], "untrained_experimental")

        res = runtime.generate_text("Hello world", max_new_tokens=16)
        self.assertFalse(res["ok"])
        self.assertEqual(res["mode"], "demo")
        self.assertFalse(res["trained"])
        self.assertTrue(res["experimental"])
        self.assertEqual(res["text"], "")

        # 2. Sidecar metadata inspection on missing checkpoint
        with tempfile.TemporaryDirectory() as tmp:
            missing_ckpt = Path(tmp) / "latest.pt"
            meta = inspect_checkpoint_metadata(missing_ckpt)
            self.assertFalse(meta["checkpoint_exists"])
            self.assertFalse(meta["trained"])
            self.assertEqual(meta["model_status"], "untrained_experimental")

            # Simulated trained sidecar + dummy .pt file is detected accurately without loading
            missing_ckpt.write_bytes(b"mock-pt-header")
            missing_ckpt.with_suffix(".meta.json").write_text(
                json.dumps(
                    {
                        "experimental": True,
                        "trained_steps": 40,
                        "train_loss": 2.34,
                        "val_loss": 2.41,
                    }
                ),
                encoding="utf-8",
            )
            inspected = inspect_checkpoint_metadata(missing_ckpt)
            self.assertTrue(inspected["checkpoint_exists"])
            self.assertTrue(inspected["trained"])
            self.assertEqual(inspected["model_status"], "experimental_trained")
            self.assertEqual(inspected["trained_steps"], 40)

        # 3. Adapter probe & generation stay honestly in Demo Mode when untrained
        from app.ai.genesis_core_adapter import GenesisCorePlaceholderAdapter
        from app.ai.interfaces import InferenceRequest

        adapter = GenesisCorePlaceholderAdapter(weights_path="./nonexistent/latest.pt")
        probe = asyncio.run(adapter.health_probe())
        self.assertFalse(probe["reachable"])
        self.assertFalse(probe["trained"])
        self.assertTrue(probe["experimental"])
        self.assertEqual(probe["model_status"], "untrained_experimental")

        gen = asyncio.run(
            adapter.generate(InferenceRequest(messages=[{"role": "user", "content": "hi"}]))
        )
        self.assertEqual(gen.mode, "demo")
        self.assertEqual(gen.finish_reason, "not_connected")
        self.assertIn("Untrained / Experimental Prototype", gen.content)


@unittest.skipUnless(HAS_TORCH, "PyTorch is not installed in this container environment")
class GenesisCorePyTorchTests(unittest.TestCase):
    def test_model_initialization_and_tensor_shapes(self) -> None:
        import torch

        cfg = GenesisCoreConfig(vocab_size=300, context_length=32, d_model=64, n_heads=4, n_layers=2)
        model = GenesisCoreTransformer(cfg)
        self.assertGreater(model.count_parameters(), 50_000)

        idx = torch.randint(0, cfg.vocab_size, (3, 12))
        logits, loss = model(idx)
        self.assertEqual(tuple(logits.shape), (3, 12, cfg.vocab_size))
        self.assertIsNone(loss)

    def test_forward_pass_with_targets_computes_finite_loss(self) -> None:
        import torch

        cfg = GenesisCoreConfig(vocab_size=300, context_length=32, d_model=64, n_heads=4, n_layers=2)
        model = GenesisCoreTransformer(cfg)
        x = torch.randint(0, cfg.vocab_size, (2, 16))
        y = torch.randint(0, cfg.vocab_size, (2, 16))
        logits, loss = model(x, y)
        self.assertEqual(tuple(logits.shape), (2, 16, cfg.vocab_size))
        self.assertIsNotNone(loss)
        self.assertTrue(torch.isfinite(loss).item())

    def test_single_training_step_updates_parameters(self) -> None:
        import torch

        tok = GenesisByteBPETokenizer()
        tok.train(SAMPLE_LOCAL_TEXT, target_vocab_size=300, min_frequency=2)
        all_ids = tok.encode(SAMPLE_LOCAL_TEXT)
        train_ids, val_ids = create_train_val_splits(all_ids, val_split=0.15)
        cfg = GenesisCoreConfig(
            vocab_size=tok.vocab_size,
            context_length=24,
            d_model=48,
            n_heads=4,
            n_layers=2,
            dropout=0.0,
        )
        batcher = TextSequenceBatcher(train_ids, val_ids, context_length=cfg.context_length, seed=5)
        model = GenesisCoreTransformer(cfg)
        before_norm = torch.norm(model.blocks[0].attn.qkv_proj.weight.detach()).item()

        with tempfile.TemporaryDirectory() as tmp:
            train_cfg = TrainingConfig(
                batch_size=2,
                gradient_accumulation_steps=1,
                max_steps=1,
                eval_interval=1,
                eval_batches=1,
                save_interval=1,
                num_threads=2,
                device="cpu",
                checkpoint_dir=tmp,
            )
            trainer = GenesisCoreTrainer(model, tok, batcher, cfg, train_cfg)
            summary = trainer.train()
            self.assertEqual(summary["steps_completed"], 1)
            self.assertGreater(summary["final_train_loss"], 0.0)

        after_norm = torch.norm(model.blocks[0].attn.qkv_proj.weight.detach()).item()
        self.assertNotEqual(before_norm, after_norm)

    def test_checkpoint_save_load_and_local_inference(self) -> None:
        tok = GenesisByteBPETokenizer()
        tok.train(SAMPLE_LOCAL_TEXT, target_vocab_size=300, min_frequency=2)
        all_ids = tok.encode(SAMPLE_LOCAL_TEXT)
        train_ids, val_ids = create_train_val_splits(all_ids, val_split=0.15)

        cfg = GenesisCoreConfig(
            vocab_size=tok.vocab_size,
            context_length=24,
            d_model=48,
            n_heads=4,
            n_layers=2,
            dropout=0.0,
        )
        batcher = TextSequenceBatcher(train_ids, val_ids, context_length=cfg.context_length, seed=11)

        with tempfile.TemporaryDirectory() as tmp:
            ckpt_dir = Path(tmp) / "ckpts"
            train_cfg = TrainingConfig(
                batch_size=2,
                gradient_accumulation_steps=1,
                max_steps=4,
                eval_interval=2,
                eval_batches=2,
                save_interval=4,
                num_threads=2,
                device="cpu",
                checkpoint_dir=str(ckpt_dir),
            )
            model = GenesisCoreTransformer(cfg)
            trainer = GenesisCoreTrainer(model, tok, batcher, cfg, train_cfg)
            summary = trainer.train()

            self.assertTrue(summary["experimental"])
            self.assertEqual(summary["steps_completed"], 4)
            self.assertGreater(summary["final_train_loss"], 0.0)
            self.assertGreater(summary["final_val_loss"], 0.0)

            latest_pt = Path(summary["latest_checkpoint"])
            self.assertTrue(latest_pt.exists())
            meta = inspect_checkpoint_metadata(latest_pt)
            self.assertTrue(meta["trained"])
            self.assertEqual(meta["trained_steps"], 4)

            loaded = load_checkpoint(latest_pt, device="cpu")
            self.assertEqual(loaded["step"], 4)

            # Inference interface loads trained checkpoint and emits generated tokens
            runtime = GenesisCoreLocalInference.from_checkpoint(latest_pt)
            self.assertTrue(runtime.is_loaded)
            self.assertTrue(runtime.is_trained)
            out = runtime.generate_text("Project Genesis", max_new_tokens=12, temperature=0.8)
            self.assertTrue(out["ok"])
            self.assertTrue(out["experimental"])
            self.assertTrue(out["trained"])
            self.assertEqual(out["mode"], "genesis_core")
            self.assertGreater(out["usage"]["completion_tokens"], 0)


if __name__ == "__main__":
    unittest.main()
