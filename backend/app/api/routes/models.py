import json
import sys
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException

BACKEND_ROOT = Path(__file__).resolve().parents[3]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.ai.genesis_core_adapter import GenesisCorePlaceholderAdapter
from app.ai.registry import resolve_model_adapter
from app.api.deps import require_authenticated_session
from app.core.config import get_settings
from app.core.security import is_local_inference_url_safe
from app.db.database import get_connection, get_core_settings, utc_now
from app.db.schemas import ModelCreate, ModelUpdatePayload
from genesis_core.checkpoint import HAS_TORCH, inspect_checkpoint_metadata
from genesis_core.config import GenesisCoreConfig

router = APIRouter(
    tags=["Models"],
    dependencies=[Depends(require_authenticated_session)],
)


@router.get("/genesis-core/status")
def genesis_core_status() -> dict[str, object]:
    """
    Inspect local Genesis Core model architecture presets and checkpoint status.
    Never downloads weights or fabricates training results.
    """
    settings = get_settings()
    ckpt_meta = inspect_checkpoint_metadata(settings.resolved_genesis_core_checkpoint)
    tok_path = settings.resolved_genesis_core_tokenizer
    return {
        "experimental": True,
        "torch_available": HAS_TORCH,
        "trained": bool(ckpt_meta["trained"]),
        "model_status": ckpt_meta["model_status"],
        "trained_steps": ckpt_meta["trained_steps"],
        "train_loss": ckpt_meta.get("train_loss"),
        "val_loss": ckpt_meta.get("val_loss"),
        "checkpoint_path": str(settings.genesis_core_checkpoint_path),
        "checkpoint_exists": ckpt_meta["checkpoint_exists"],
        "tokenizer_path": str(settings.genesis_core_tokenizer_path),
        "tokenizer_exists": tok_path.exists() and tok_path.is_file(),
        "architecture": {
            "class_name": "GenesisCoreTransformer",
            "tokenizer_class": "GenesisByteBPETokenizer",
            "presets": {
                "cpu_nano": GenesisCoreConfig.cpu_nano().to_dict(),
                "cpu_micro": GenesisCoreConfig.cpu_micro().to_dict(),
                "cpu_small": GenesisCoreConfig.cpu_small().to_dict(),
            },
        },
        "training_command": (
            "python backend/scripts/train_genesis_core.py "
            "--corpus ./docs --preset cpu_nano --steps 100"
        ),
    }


@router.get("/models")
def list_models() -> list[dict[str, object]]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM models ORDER BY created_at ASC").fetchall()
        return [{**dict(r), "metadata": json.loads(r["metadata_json"] or "{}")} for r in rows]
    finally:
        conn.close()


@router.post("/models", status_code=201)
def register_model(payload: ModelCreate) -> dict[str, object]:
    if payload.endpoint_url.strip():
        safe, reason = is_local_inference_url_safe(payload.endpoint_url.strip())
        if not safe:
            raise HTTPException(status_code=400, detail=reason)

    conn = get_connection()
    now = utc_now()
    model_id = f"model-{uuid.uuid4()}"
    arch_name = (
        "GenesisCoreTransformer" if payload.provider == "genesis_core" else "CustomLocalModel"
    )
    metadata = {"architecture": arch_name, "weights_verified": False, "notes": payload.notes}
    try:
        conn.execute(
            """
            INSERT INTO models (
                id, name, provider, model_type, local_path, endpoint_url, status, loading_status,
                context_length, quantization, parameter_count, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                model_id,
                payload.name.strip(),
                payload.provider,
                payload.model_type,
                payload.local_path.strip(),
                payload.endpoint_url.strip(),
                "registered",
                "unloaded",
                payload.context_length,
                payload.quantization,
                payload.parameter_count,
                json.dumps(metadata),
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
        return {**dict(row), "metadata": metadata}
    finally:
        conn.close()


@router.put("/models/{model_id}")
def update_model(model_id: str, payload: ModelUpdatePayload) -> dict[str, object]:
    conn = get_connection()
    try:
        existing = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Model not found.")

        next_endpoint = (
            payload.endpoint_url.strip()
            if payload.endpoint_url is not None
            else existing["endpoint_url"]
        )
        if next_endpoint:
            safe, reason = is_local_inference_url_safe(next_endpoint)
            if not safe:
                raise HTTPException(status_code=400, detail=reason)

        next_name = (
            (payload.name.strip() or existing["name"])
            if payload.name is not None
            else existing["name"]
        )
        next_path = (
            payload.local_path.strip() if payload.local_path is not None else existing["local_path"]
        )
        next_ctx = (
            min(131072, max(128, round(payload.context_length)))
            if payload.context_length is not None
            else existing["context_length"]
        )
        now = utc_now()
        conn.execute(
            "UPDATE models SET name = ?, local_path = ?, endpoint_url = ?, context_length = ?, updated_at = ? WHERE id = ?",
            (next_name, next_path, next_endpoint, next_ctx, now, model_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
        return {**dict(row), "metadata": json.loads(row["metadata_json"] or "{}")}
    finally:
        conn.close()


@router.post("/models/{model_id}/probe")
async def probe_model(model_id: str) -> dict[str, object]:
    settings = get_settings()
    conn = get_connection()
    try:
        core_cfg = get_core_settings(conn)
        default_endpoint = str(core_cfg.get("inference_endpoint_url", settings.genesis_inference_url))
        try:
            adapter, row = resolve_model_adapter(conn, model_id, default_endpoint)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

        now = utc_now()
        probe = await adapter.health_probe()
        if row["provider"] == "genesis_core":
            return {
                "id": model_id,
                "reachable": bool(probe.get("reachable", False)),
                "status": "placeholder",
                "loading_status": "loaded" if probe.get("reachable") else "unloaded",
                "detected_models": probe.get("detected_models", []),
                "server_model": probe.get("server_model"),
                "experimental": True,
                "trained": bool(probe.get("trained", False)),
                "model_status": probe.get("model_status", "untrained_experimental"),
                "message": probe["message"],
            }

        try:
            existing_meta = json.loads(row.get("metadata_json") or "{}")
        except Exception:
            existing_meta = {}
        updated_meta = {
            **(existing_meta if isinstance(existing_meta, dict) else {}),
            "detected_models": probe.get("detected_models", []),
            "server_model": probe.get("server_model"),
            "last_probe_at": now,
        }

        has_endpoint = bool(
            str(row.get("endpoint_url") or "").strip()
            or (model_id == "local-inference-http" and default_endpoint)
        )
        next_status = (
            "registered"
            if not has_endpoint
            else ("connected" if probe["reachable"] else "unreachable")
        )
        next_loading = "loaded" if probe["reachable"] else "unloaded"
        conn.execute(
            "UPDATE models SET status = ?, loading_status = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
            (next_status, next_loading, json.dumps(updated_meta), now, model_id),
        )
        conn.commit()
        return {
            "id": model_id,
            "reachable": probe["reachable"],
            "status": next_status,
            "loading_status": next_loading,
            "detected_models": probe.get("detected_models", []),
            "server_model": probe.get("server_model"),
            "message": probe["message"],
            "payload": probe.get("payload"),
        }
    finally:
        conn.close()


@router.post("/models/{model_id}/load")
async def load_model_weights(model_id: str) -> dict[str, object]:
    settings = get_settings()
    conn = get_connection()
    try:
        core_cfg = get_core_settings(conn)
        default_endpoint = str(core_cfg.get("inference_endpoint_url", settings.genesis_inference_url))
        try:
            adapter, row = resolve_model_adapter(conn, model_id, default_endpoint)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

        if not isinstance(adapter, GenesisCorePlaceholderAdapter):
            raise HTTPException(
                status_code=400,
                detail="Explicit checkpoint loading is only supported for genesis_core adapters.",
            )

        loaded, message = await adapter.load_weights(str(row.get("local_path") or ""))
        now = utc_now()
        next_loading = "loaded" if loaded else "unloaded"
        conn.execute(
            "UPDATE models SET loading_status = ?, updated_at = ? WHERE id = ?",
            (next_loading, now, model_id),
        )
        conn.commit()
        return {
            "id": model_id,
            "loaded": loaded,
            "loading_status": next_loading,
            "experimental": True,
            "message": message,
        }
    finally:
        conn.close()


@router.post("/models/{model_id}/unload")
async def unload_model_weights(model_id: str) -> dict[str, object]:
    settings = get_settings()
    conn = get_connection()
    try:
        core_cfg = get_core_settings(conn)
        default_endpoint = str(core_cfg.get("inference_endpoint_url", settings.genesis_inference_url))
        try:
            adapter, _ = resolve_model_adapter(conn, model_id, default_endpoint)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

        if isinstance(adapter, GenesisCorePlaceholderAdapter):
            await adapter.unload_weights()

        now = utc_now()
        conn.execute(
            "UPDATE models SET loading_status = ?, updated_at = ? WHERE id = ?",
            ("unloaded", now, model_id),
        )
        conn.commit()
        return {
            "id": model_id,
            "loaded": False,
            "loading_status": "unloaded",
            "experimental": True,
            "message": "Genesis Core weights unloaded from memory.",
        }
    finally:
        conn.close()


@router.delete("/models/{model_id}")
def delete_model(model_id: str) -> dict[str, object]:
    if model_id == "genesis-core-placeholder":
        raise HTTPException(status_code=400, detail="Core placeholder adapter cannot be removed.")
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM models WHERE id = ?", (model_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Model not found.")
        return {"deleted": True, "id": model_id}
    finally:
        conn.close()
