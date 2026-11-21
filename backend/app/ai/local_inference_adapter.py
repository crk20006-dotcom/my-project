import json
from collections.abc import AsyncIterator
from typing import Any

try:
    import httpx
except ImportError:  # pragma: no cover - container fallback when httpx is absent
    httpx = None  # type: ignore[assignment]

from app.ai.interfaces import (
    BaseInferenceEngine,
    BaseModelAdapter,
    InferenceChunk,
    InferenceRequest,
    InferenceResponse,
    ModelCapabilities,
)
from app.ai.tokenizer import BaselineTokenizer
from app.core.security import is_local_inference_url_safe


class LocalWeightsManifestAdapter(BaseModelAdapter, BaseInferenceEngine):
    """Adapter for registered local GGUF/Safetensors manifests without an active HTTP endpoint. Never auto-loads weights."""

    def __init__(
        self,
        model_id: str,
        model_name: str,
        provider: str,
        local_path: str = "",
        context_length: int = 8192,
    ) -> None:
        self._model_id = model_id
        self._model_name = model_name
        self._provider = provider
        self._local_path = local_path
        self._context_length = context_length
        self._tokenizer = BaselineTokenizer()

    @property
    def model_id(self) -> str:
        return self._model_id

    async def load_weights(self, local_path: str) -> tuple[bool, str]:
        return (
            False,
            f"Auto-loading local weights is disabled by safety policy ({local_path}). Start a local inference server.",
        )

    async def unload_weights(self) -> None:
        return None

    def get_capabilities(self) -> ModelCapabilities:
        return ModelCapabilities(
            max_context_tokens=self._context_length,
            supports_streaming=False,
            supports_tool_calling=False,
            provider=self._provider,
        )

    async def health_probe(self) -> dict[str, Any]:
        return {
            "reachable": False,
            "status_code": None,
            "detected_models": [],
            "server_model": None,
            "message": (
                f'Manifest "{self._model_name}" registered (weights are never auto-loaded). '
                "Configure a loopback inference server endpoint to dispatch prompts."
            ),
        }

    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        last_user = next(
            (m["content"] for m in reversed(request.messages) if m.get("role") == "user"),
            "",
        )
        stats = self._tokenizer.inspect(last_user, self._context_length)
        content = (
            f"### Demo Mode — Local Runtime Not Attached for `{self._model_name}`\n\n"
            f"This manifest ({self._provider}) points to `{self._local_path or 'unconfigured weights path'}` "
            "without a local HTTP inference server endpoint. Project Genesis never auto-loads weights or falls back to external AI APIs."
        )
        return InferenceResponse(
            ok=True,
            mode="demo",
            model_name=f"DEMO MODE ({self._model_name})",
            finish_reason="not_connected",
            diagnostic=True,
            content=content,
            usage={"prompt_tokens": stats["token_count"], "completion_tokens": 0},
        )


class LocalHttpInferenceAdapter(BaseModelAdapter, BaseInferenceEngine):
    """
    Communicates with a locally hosted OpenAI-compatible inference server (e.g., llama.cpp server).
    Enforces localhost/loopback-only URL policy by default.
    """

    def __init__(
        self,
        endpoint_url: str,
        model_id: str = "local-inference-http",
        provider: str = "local_http",
        model_label: str = "Local Inference Server Adapter",
        server_model_name: str | None = None,
        context_length: int = 8192,
    ) -> None:
        self.endpoint_url = endpoint_url.strip().rstrip("/")
        self._model_id = model_id
        self._provider = provider
        self._model_label = model_label
        self._server_model_name = server_model_name
        self._context_length = context_length

    @property
    def model_id(self) -> str:
        return self._model_id

    async def load_weights(self, local_path: str) -> tuple[bool, str]:
        return (
            False,
            f"Weights are managed externally by the local inference process at {self.endpoint_url or 'unconfigured endpoint'}.",
        )

    async def unload_weights(self) -> None:
        return None

    def get_capabilities(self) -> ModelCapabilities:
        return ModelCapabilities(
            max_context_tokens=self._context_length,
            supports_streaming=True,
            supports_tool_calling=False,
            provider=self._provider,
        )

    def _build_body(self, request: InferenceRequest, stream: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "messages": request.messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": stream,
        }
        model_name = request.model or self._server_model_name
        if model_name:
            body["model"] = model_name
        return body

    async def health_probe(self) -> dict[str, Any]:
        if not self.endpoint_url:
            return {
                "reachable": False,
                "status_code": None,
                "detected_models": [],
                "server_model": None,
                "message": "No local HTTP inference endpoint configured.",
            }

        safe, reason = is_local_inference_url_safe(self.endpoint_url)
        if not safe:
            return {
                "reachable": False,
                "status_code": None,
                "detected_models": [],
                "server_model": None,
                "message": reason,
            }

        if httpx is None:
            return {
                "reachable": False,
                "status_code": None,
                "detected_models": [],
                "server_model": None,
                "message": "Python httpx dependency is not installed in this runtime.",
            }

        detected_models: list[str] = []
        health_status: int | None = None
        health_ok = False
        health_payload: Any = None

        try:
            async with httpx.AsyncClient(timeout=2.5) as client:
                try:
                    resp = await client.get(f"{self.endpoint_url}/health")
                    health_status = resp.status_code
                    health_ok = resp.status_code < 400
                    try:
                        health_payload = resp.json()
                    except Exception:
                        health_payload = None
                except Exception as exc:
                    # Fallback to /v1/models if /health failed
                    try:
                        m_resp = await client.get(f"{self.endpoint_url}/v1/models")
                        if m_resp.status_code < 400:
                            m_data = m_resp.json()
                            for entry in m_data.get("data", []) or []:
                                if isinstance(entry, dict) and entry.get("id"):
                                    detected_models.append(str(entry["id"]))
                            server_model = detected_models[0] if detected_models else None
                            return {
                                "reachable": True,
                                "status_code": m_resp.status_code,
                                "detected_models": detected_models,
                                "server_model": server_model,
                                "message": (
                                    f"Connected via /v1/models (HTTP {m_resp.status_code}). Detected model: {server_model}."
                                    if server_model
                                    else f"Connected to local inference server via /v1/models (HTTP {m_resp.status_code})."
                                ),
                                "payload": m_data,
                            }
                    except Exception:
                        pass
                    return {
                        "reachable": False,
                        "status_code": None,
                        "detected_models": [],
                        "server_model": None,
                        "message": f"No local inference server reachable at {self.endpoint_url} ({exc}).",
                    }

                try:
                    m_resp = await client.get(f"{self.endpoint_url}/v1/models")
                    if m_resp.status_code < 400:
                        m_data = m_resp.json()
                        for entry in m_data.get("data", []) or []:
                            if isinstance(entry, dict) and entry.get("id"):
                                detected_models.append(str(entry["id"]))
                except Exception:
                    pass

            reachable = health_ok or len(detected_models) > 0
            server_model = detected_models[0] if detected_models else None
            return {
                "reachable": reachable,
                "status_code": health_status,
                "detected_models": detected_models,
                "server_model": server_model,
                "message": (
                    f"Connected to {self.endpoint_url} (HTTP {health_status or 200}). Model: {server_model}."
                    if reachable and server_model
                    else f"Local inference server responded with HTTP {health_status}."
                ),
                "payload": health_payload,
            }
        except Exception as exc:
            return {
                "reachable": False,
                "status_code": None,
                "detected_models": [],
                "server_model": None,
                "message": f"No local inference server reachable at {self.endpoint_url} ({exc}).",
            }

    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        if not self.endpoint_url:
            return InferenceResponse(
                ok=False,
                mode="demo",
                model_name="DEMO MODE (No Endpoint Configured)",
                finish_reason="error",
                diagnostic=True,
                content="",
                error="No local inference endpoint URL configured for this model.",
            )

        safe, reason = is_local_inference_url_safe(self.endpoint_url)
        if not safe:
            return InferenceResponse(
                ok=False,
                mode="demo",
                model_name="DEMO MODE (Endpoint Blocked)",
                finish_reason="error",
                diagnostic=True,
                content="",
                error=reason,
            )

        if httpx is None:
            return InferenceResponse(
                ok=False,
                mode="demo",
                model_name=f"DEMO MODE ({self._model_label})",
                finish_reason="error",
                diagnostic=True,
                content="",
                error="Python httpx dependency is not installed in this runtime.",
            )

        try:
            async with httpx.AsyncClient(timeout=max(1.0, request.timeout_seconds)) as client:
                resp = await client.post(
                    f"{self.endpoint_url}/v1/chat/completions",
                    json=self._build_body(request, stream=False),
                )
            if resp.status_code >= 400:
                return InferenceResponse(
                    ok=False,
                    mode="demo",
                    model_name=f"DEMO MODE ({self._model_label})",
                    finish_reason="error",
                    diagnostic=True,
                    content="",
                    error=f"Local inference endpoint returned HTTP {resp.status_code}",
                )
            try:
                payload = resp.json()
            except Exception:
                return InferenceResponse(
                    ok=False,
                    mode="demo",
                    model_name=f"DEMO MODE ({self._model_label})",
                    finish_reason="error",
                    diagnostic=True,
                    content="",
                    error="Local inference server returned invalid JSON payload.",
                )

            choices = payload.get("choices") if isinstance(payload, dict) else None
            first = choices[0] if isinstance(choices, list) and choices else {}
            text = (
                (first.get("message") or {}).get("content")
                if isinstance(first, dict)
                else None
            )
            if not text and isinstance(first, dict):
                text = first.get("text")
            if not text and isinstance(payload, dict):
                text = payload.get("response")

            if not isinstance(text, str) or not text:
                return InferenceResponse(
                    ok=False,
                    mode="demo",
                    model_name=f"DEMO MODE ({self._model_label})",
                    finish_reason="error",
                    diagnostic=True,
                    content="",
                    error="Local inference response missing expected text payload.",
                )

            model_label = (
                f"{payload['model']} ({self.endpoint_url})"
                if isinstance(payload, dict) and payload.get("model")
                else f"{self._model_label} ({self.endpoint_url})"
            )
            usage = payload.get("usage") if isinstance(payload, dict) and isinstance(payload.get("usage"), dict) else {}
            return InferenceResponse(
                ok=True,
                mode="local_inference",
                model_name=model_label,
                finish_reason=str((first.get("finish_reason") if isinstance(first, dict) else None) or "stop"),
                diagnostic=False,
                content=text,
                usage={k: int(v) for k, v in usage.items() if isinstance(v, (int, float))},
            )
        except Exception as exc:
            return InferenceResponse(
                ok=False,
                mode="demo",
                model_name=f"DEMO MODE ({self._model_label})",
                finish_reason="error",
                diagnostic=True,
                content="",
                error=str(exc),
            )

    async def generate_stream(self, request: InferenceRequest) -> AsyncIterator[InferenceChunk]:
        if not self.endpoint_url:
            yield InferenceChunk(type="error", error="No local inference endpoint URL configured.", finish_reason="error")
            return

        safe, reason = is_local_inference_url_safe(self.endpoint_url)
        if not safe:
            yield InferenceChunk(type="error", error=reason, finish_reason="error")
            return

        if httpx is None:
            yield InferenceChunk(
                type="error",
                error="Python httpx dependency is not installed in this runtime.",
                finish_reason="error",
            )
            return

        accumulated = ""
        resolved_model = f"{self._model_label} ({self.endpoint_url})"
        finish_reason = "stop"
        usage: dict[str, int] = {}

        try:
            async with httpx.AsyncClient(timeout=max(1.0, request.timeout_seconds)) as client:
                async with client.stream(
                    "POST",
                    f"{self.endpoint_url}/v1/chat/completions",
                    json=self._build_body(request, stream=True),
                ) as resp:
                    if resp.status_code >= 400:
                        yield InferenceChunk(
                            type="error",
                            error=f"Local inference endpoint returned HTTP {resp.status_code}",
                            finish_reason="error",
                        )
                        return

                    content_type = (resp.headers.get("content-type") or "").lower()
                    if "application/json" in content_type:
                        raw_bytes = await resp.aread()
                        try:
                            payload = json.loads(raw_bytes.decode("utf-8"))
                        except Exception:
                            yield InferenceChunk(
                                type="error",
                                error="Local inference server returned invalid JSON payload.",
                                finish_reason="error",
                            )
                            return
                        first = (payload.get("choices") or [{}])[0] if isinstance(payload, dict) else {}
                        text = (first.get("message") or {}).get("content") or first.get("text") or payload.get("response")
                        if not isinstance(text, str) or not text:
                            yield InferenceChunk(
                                type="error",
                                error="Local inference response missing expected text payload.",
                                finish_reason="error",
                            )
                            return
                        if isinstance(payload, dict) and payload.get("model"):
                            resolved_model = f"{payload['model']} ({self.endpoint_url})"
                        yield InferenceChunk(type="delta", delta=text, content=text, mode="local_inference", model_name=resolved_model)
                        yield InferenceChunk(
                            type="done",
                            content=text,
                            mode="local_inference",
                            model_name=resolved_model,
                            finish_reason=str(first.get("finish_reason") or "stop"),
                            usage=payload.get("usage") or {},
                            diagnostic=False,
                        )
                        return

                    async for raw_line in resp.aiter_lines():
                        line = raw_line.strip()
                        if not line or line.startswith(":") or not line.startswith("data:"):
                            continue
                        payload_str = line[5:].strip()
                        if payload_str == "[DONE]":
                            yield InferenceChunk(
                                type="done",
                                content=accumulated,
                                mode="local_inference",
                                model_name=resolved_model,
                                finish_reason=finish_reason,
                                usage=usage,
                                diagnostic=False,
                            )
                            return

                        try:
                            parsed = json.loads(payload_str)
                        except Exception:
                            yield InferenceChunk(
                                type="error",
                                content=accumulated,
                                error="Local inference stream emitted malformed JSON chunk.",
                                finish_reason="error",
                            )
                            return

                        if isinstance(parsed, dict):
                            if parsed.get("model"):
                                resolved_model = f"{parsed['model']} ({self.endpoint_url})"
                            if isinstance(parsed.get("usage"), dict):
                                usage = {k: int(v) for k, v in parsed["usage"].items() if isinstance(v, (int, float))}
                            choices = parsed.get("choices") or []
                            choice = choices[0] if choices else {}
                            if isinstance(choice, dict):
                                if choice.get("finish_reason"):
                                    finish_reason = str(choice["finish_reason"])
                                delta = (
                                    (choice.get("delta") or {}).get("content")
                                    or (choice.get("message") or {}).get("content")
                                    or choice.get("text")
                                    or parsed.get("content")
                                    or ""
                                )
                            else:
                                delta = parsed.get("content") or ""
                            if isinstance(delta, str) and delta:
                                accumulated += delta
                                yield InferenceChunk(
                                    type="delta",
                                    delta=delta,
                                    content=accumulated,
                                    mode="local_inference",
                                    model_name=resolved_model,
                                )

            if not accumulated:
                yield InferenceChunk(
                    type="error",
                    error="Local inference stream closed without generating any tokens.",
                    finish_reason="error",
                )
                return

            yield InferenceChunk(
                type="done",
                content=accumulated,
                mode="local_inference",
                model_name=resolved_model,
                finish_reason=finish_reason,
                usage=usage,
                diagnostic=False,
            )
        except Exception as exc:
            yield InferenceChunk(
                type="error",
                content=accumulated,
                mode="local_inference" if accumulated else "demo",
                model_name=resolved_model,
                error=str(exc),
                finish_reason="error",
            )
