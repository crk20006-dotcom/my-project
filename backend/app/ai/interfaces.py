from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelCapabilities:
    max_context_tokens: int
    supports_streaming: bool
    supports_tool_calling: bool
    provider: str = "genesis_core"


@dataclass
class InferenceRequest:
    messages: list[dict[str, str]]
    model: str | None = None
    max_tokens: int = 512
    temperature: float = 0.2
    timeout_seconds: float = 30.0
    system_prompt: str | None = None


@dataclass
class InferenceResponse:
    mode: str
    content: str
    finish_reason: str
    model_name: str
    ok: bool = True
    diagnostic: bool = False
    error: str | None = None
    usage: dict[str, int] = field(default_factory=dict)


@dataclass
class InferenceChunk:
    type: str  # 'delta' | 'done' | 'error'
    delta: str | None = None
    content: str | None = None
    mode: str | None = None
    model_name: str | None = None
    finish_reason: str | None = None
    usage: dict[str, int] = field(default_factory=dict)
    error: str | None = None
    diagnostic: bool = False


class BaseModelAdapter(ABC):
    """Abstract lifecycle contract for any future foundation model or local weights."""

    @property
    @abstractmethod
    def model_id(self) -> str: ...

    @abstractmethod
    async def load_weights(self, local_path: str) -> tuple[bool, str]: ...

    @abstractmethod
    async def unload_weights(self) -> None: ...

    @abstractmethod
    def get_capabilities(self) -> ModelCapabilities: ...


class BaseInferenceEngine(ABC):
    """Abstract inference contract decoupling UI/API from neural runtime implementation."""

    async def health_probe(self) -> dict[str, Any]:
        return {
            "reachable": False,
            "status_code": None,
            "detected_models": [],
            "server_model": None,
            "message": "Health probe not implemented for this adapter.",
        }

    @abstractmethod
    async def generate(self, request: InferenceRequest) -> InferenceResponse: ...

    async def generate_stream(self, request: InferenceRequest) -> AsyncIterator[InferenceChunk]:
        resp = await self.generate(request)
        if not resp.ok:
            yield InferenceChunk(
                type="error",
                content=resp.content,
                mode=resp.mode,
                model_name=resp.model_name,
                finish_reason=resp.finish_reason,
                usage=resp.usage,
                error=resp.error or "Inference failed",
                diagnostic=resp.diagnostic,
            )
            return
        yield InferenceChunk(
            type="done",
            content=resp.content,
            mode=resp.mode,
            model_name=resp.model_name,
            finish_reason=resp.finish_reason,
            usage=resp.usage,
            diagnostic=resp.diagnostic,
        )


class BaseTokenizer(ABC):
    """Abstract tokenizer contract for segmentation, byte inspection, and context budgeting."""

    @abstractmethod
    def encode(self, text: str) -> list[int]: ...

    @abstractmethod
    def decode(self, ids: list[int]) -> str: ...

    @abstractmethod
    def inspect(self, text: str, context_limit: int = 8192) -> dict[str, Any]: ...


class BaseMemoryStore(ABC):
    """Abstract persistent memory contract."""

    @abstractmethod
    def store(self, namespace: str, title: str, content: str, tags: list[str], importance: int) -> str: ...

    @abstractmethod
    def query(self, namespace: str | None, search_term: str) -> list[dict[str, Any]]: ...


class BaseAgentOrchestrator(ABC):
    """Abstract step-budgeted autonomous orchestration contract."""

    @abstractmethod
    def plan_steps(self, goal: str, allowed_tools: list[str], max_steps: int) -> list[dict[str, Any]]: ...


class BaseToolExecutor(ABC):
    """Abstract sandboxed tool execution boundary."""

    @abstractmethod
    def list_allowed_tools(self) -> list[str]: ...

    @abstractmethod
    def validate_execution(self, tool_name: str, args: dict[str, Any]) -> tuple[bool, str]: ...


class ModelConfigManager:
    """Manages registered model manifests and active endpoint metadata."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def list_models(self) -> list[dict[str, Any]]:
        rows = self._conn.execute("SELECT * FROM models ORDER BY created_at ASC").fetchall()
        return [dict(r) for r in rows]
