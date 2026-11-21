from typing import Any
from pydantic import BaseModel, Field


class ConversationCreate(BaseModel):
    title: str = "New Conversation"
    module: str = "chat"
    model_id: str | None = None


class ConversationRename(BaseModel):
    title: str | None = None
    model_id: str | None = None


class AttachmentSchema(BaseModel):
    id: str
    name: str
    size: int
    mimeType: str = "application/octet-stream"
    extension: str
    previewText: str | None = None
    validated: bool = True


class MessageCreate(BaseModel):
    content: str = ""
    attachments: list[AttachmentSchema] = Field(default_factory=list)
    model_id: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    timeout_ms: int | None = None
    use_memory: bool = True
    use_knowledge: bool = True


class MemoryCreate(BaseModel):
    namespace: str = "semantic"
    category: str = "fact"
    title: str
    content: str
    tags: list[str] = Field(default_factory=list)
    importance: int = Field(default=3, ge=1, le=5)
    approved: bool = True
    source_conversation_id: str | None = None


class MemoryUpdate(BaseModel):
    namespace: str | None = None
    category: str | None = None
    title: str | None = None
    content: str | None = None
    tags: list[str] | None = None
    importance: int | None = Field(default=None, ge=1, le=5)


class KnowledgeDocumentCreate(BaseModel):
    title: str
    source_type: str = "note"
    source_name: str = ""
    content: str
    tags: list[str] = Field(default_factory=list)


class KnowledgeDocumentUpdate(BaseModel):
    title: str | None = None
    source_type: str | None = None
    source_name: str | None = None
    content: str | None = None
    tags: list[str] | None = None


class RetrievalQueryPayload(BaseModel):
    query: str
    include_memory: bool = True
    include_knowledge: bool = True
    max_memory_items: int = Field(default=3, ge=0, le=6)
    max_knowledge_chunks: int = Field(default=3, ge=0, le=6)


class ResearchProjectPayload(BaseModel):
    title: str
    summary: str = ""
    status: str = "active"
    tags: list[str] = Field(default_factory=list)
    sources: list[dict[str, Any]] = Field(default_factory=list)
    notes: str = ""


class ModelCreate(BaseModel):
    name: str
    provider: str = "gguf_local"
    model_type: str = "Local Foundation Weights"
    local_path: str = ""
    endpoint_url: str = ""
    context_length: int = 8192
    quantization: str = "Q4_K_M"
    parameter_count: str = "Unspecified"
    notes: str = ""


class ModelUpdatePayload(BaseModel):
    name: str | None = None
    local_path: str | None = None
    endpoint_url: str | None = None
    context_length: int | None = None


class AgentCreate(BaseModel):
    name: str
    role: str
    description: str = ""
    allowed_tools: list[str] = Field(default_factory=lambda: ["health_check"])
    sandbox_policy: dict[str, Any] = Field(default_factory=dict)
    system_prompt: str = ""


class AgentTaskCreate(BaseModel):
    agent_id: str
    goal: str
    title: str | None = None
    target_file_path: str | None = None
    document_filename: str | None = None
    code_snippet: str | None = None
    max_retries: int = Field(default=1, ge=0, le=3)
    auto_run: bool = False


class AgentTaskStepApprovalPayload(BaseModel):
    approved: bool
    note: str | None = None
    resume: bool = True


class AgentTaskMemorySavePayload(BaseModel):
    approved: bool = False
    title: str | None = None
    content: str | None = None
    category: str = "fact"
    tags: list[str] = Field(default_factory=lambda: ["agent-result"])


class LaboratoryCreate(BaseModel):
    kind: str = "prompt_template"
    name: str
    content: str
    schema_json: str = "{}"
    metrics: dict[str, Any] = Field(default_factory=dict)


class CreatorArtifactPayload(BaseModel):
    title: str
    artifact_type: str = "markdown"
    language: str = "markdown"
    content: str = ""


class UploadValidatePayload(BaseModel):
    name: str
    size: int
    mimeType: str = "application/octet-stream"
    previewText: str | None = None


class SettingsUpdatePayload(BaseModel):
    operator_name: str | None = None
    local_auth_enabled: bool | None = None
    new_passcode: str | None = None
    current_passcode: str | None = None
    inference_endpoint_url: str | None = None
    prefer_local_inference: bool | None = None
    active_model_id: str | None = None
    chat_use_memory: bool | None = None
    chat_use_knowledge: bool | None = None
    inference_temperature: float | None = None
    inference_max_tokens: int | None = None
    inference_timeout_ms: int | None = None
    max_upload_mb: int | None = None
    allowed_extensions: list[str] | None = None
    sandbox_strict_mode: bool | None = None
    voice_sample_rate: int | None = None
    voice_vad_threshold: float | None = None
    voice_stt_adapter: str | None = None
    voice_tts_adapter: str | None = None


class PasscodeVerifyPayload(BaseModel):
    passcode: str = ""


class DryRunPayload(BaseModel):
    task: str = ""
