export type ModuleId =
  | 'chat'
  | 'intelligence'
  | 'engineering'
  | 'agent'
  | 'research'
  | 'laboratory'
  | 'creator'
  | 'memory'
  | 'voice'
  | 'models'
  | 'settings';

export interface AttachmentMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  extension: string;
  previewText?: string;
  imageDataUrl?: string;
  mediaKind?: 'image' | 'document' | 'audio' | 'text';
  validated: boolean;
}

export interface MemoryRetrievalSummary {
  queried: boolean;
  retrieval_backend: string;
  memories_used: Array<{ id: string; title: string; category: string }>;
  knowledge_used: Array<{ document_id: string; document_title: string; chunk_index: number }>;
  total_context_tokens: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments: AttachmentMeta[];
  metadata: {
    mode: 'demo' | 'local_inference' | 'genesis_core';
    model_id?: string;
    model_name?: string;
    token_count?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    finish_reason?: string;
    truncated_messages?: number;
    partial?: boolean;
    diagnostic?: boolean;
    memory_retrieval?: MemoryRetrievalSummary;
  };
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  module: string;
  model_id: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export type MemoryNamespace = 'episodic' | 'semantic' | 'procedural' | 'project';
export type MemoryCategory = 'fact' | 'preference' | 'instruction' | 'constraint';

export interface MemoryEntry {
  id: string;
  namespace: MemoryNamespace;
  category?: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  approved?: boolean;
  source_conversation_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_estimate: number;
  created_at: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source_type: string;
  source_name: string;
  content: string;
  tags: string[];
  chunk_count: number;
  created_at: string;
  updated_at: string;
  chunks?: KnowledgeChunk[];
}

export interface ConversationSearchHit {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: string;
  snippet: string;
  created_at: string;
}

export interface MemorySystemStatus {
  total_memories: number;
  total_knowledge_docs: number;
  total_knowledge_chunks: number;
  total_conversations: number;
  total_messages: number;
  fts5_enabled: boolean;
  auto_save_disabled: boolean;
}

export interface RetrievalQueryResponse {
  queried: boolean;
  query: string;
  retrieval_backend: 'sqlite_fts5' | 'sqlite_like';
  memories: Array<{
    id: string;
    namespace: string;
    category: string;
    title: string;
    content: string;
    importance: number;
    score: number;
  }>;
  knowledge: Array<{
    chunk_id: string;
    document_id: string;
    document_title: string;
    source_type: string;
    chunk_index: number;
    content: string;
    score: number;
  }>;
  total_context_tokens: number;
  formatted_context: string | null;
}

export interface ResearchSource {
  id: string;
  title: string;
  reference: string;
  note: string;
  url?: string;
  published_at?: string | null;
  retrieved_at?: string;
  attribution?: string;
}

export interface WorldProviderDescriptor {
  id: 'wikipedia' | 'arxiv';
  name: string;
  description: string;
  requires_api_key: false;
  endpoint_base: string;
  source_category: 'encyclopedia' | 'scientific_preprints';
}

export interface WorldSourceRecord {
  id: string;
  provider: 'wikipedia' | 'arxiv' | 'rss' | 'webpage';
  title: string;
  url: string;
  published_at: string | null;
  retrieved_at: string;
  snippet: string;
  content_type: string;
  attribution: string;
}

export interface WorldSearchResponse {
  ok: boolean;
  provider: string;
  query: string;
  retrieved_at: string;
  network_available: boolean;
  results: WorldSourceRecord[];
  error?: string;
}

export interface WorldUrlFetchResponse {
  ok: boolean;
  url: string;
  final_url: string;
  source_kind: 'rss' | 'atom' | 'html' | 'text';
  retrieved_at: string;
  network_available: boolean;
  title: string;
  published_at: string | null;
  items: WorldSourceRecord[];
  text_excerpt: string;
  error?: string;
}

export interface ResearchProject {
  id: string;
  title: string;
  summary: string;
  status: 'active' | 'draft' | 'archived';
  tags: string[];
  sources: ResearchSource[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export type ModelProviderType =
  | 'genesis_core'
  | 'local_http'
  | 'gguf_local'
  | 'safetensors_local';

export type ModelAvailabilityStatus =
  | 'placeholder'
  | 'registered'
  | 'connected'
  | 'unreachable';

export type ModelLoadingStatus =
  | 'unloaded'
  | 'staged'
  | 'loaded'
  | 'error';

export interface ModelEntry {
  id: string;
  name: string;
  provider: ModelProviderType;
  model_type: string;
  local_path: string;
  endpoint_url: string;
  status: ModelAvailabilityStatus;
  loading_status: ModelLoadingStatus;
  context_length: number;
  quantization: string;
  parameter_count: string;
  metadata: {
    architecture?: string;
    weights_verified?: boolean;
    notes?: string;
    detected_models?: string[];
    server_model?: string | null;
    last_probe_at?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface SandboxPolicy {
  allow_network: boolean;
  allow_filesystem_write: boolean;
  allow_shell_execution: boolean;
  max_steps: number;
  workspace_scope: string;
}

export interface AgentBlueprint {
  id: string;
  name: string;
  role: string;
  description: string;
  allowed_tools: string[];
  sandbox_policy: SandboxPolicy;
  system_prompt: string;
  status: 'ready' | 'draft' | 'restricted';
  created_at: string;
  updated_at: string;
}

export interface AgentToolDescriptor {
  id: string;
  name: string;
  category:
    | 'file_system'
    | 'document'
    | 'code_execution'
    | 'knowledge'
    | 'memory'
    | 'local_app'
    | 'future_extension';
  description: string;
  risk_level: 'read_only' | 'consequential' | 'reserved_stub';
  requires_approval: boolean;
  safe_retryable: boolean;
  operational: boolean;
  input_schema: Record<string, unknown>;
}

export type AgentTaskStatus =
  | 'planned'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentStepStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface AgentTaskSummary {
  id: string;
  agent_id: string;
  agent_name?: string;
  title: string;
  goal: string;
  status: AgentTaskStatus;
  current_step_index: number;
  memory_context: {
    memories: Array<{ id: string; title: string; category: string }>;
    knowledge: Array<{ document_id: string; document_title: string; chunk_index: number }>;
  };
  result_summary: string;
  error_message: string;
  max_retries: number;
  step_count?: number;
  completed_steps?: number;
  pending_approvals?: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AgentTaskStep {
  id: string;
  task_id: string;
  step_index: number;
  title: string;
  description: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: AgentStepStatus;
  requires_approval: boolean;
  approval_status: 'not_required' | 'pending' | 'approved' | 'rejected';
  approval_note: string;
  safe_retryable: boolean;
  attempts: number;
  max_attempts: number;
  output: {
    summary?: string;
    data?: Record<string, unknown>;
  };
  error_message: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AgentExecutionHistoryItem {
  id: string;
  task_id: string;
  step_id: string | null;
  agent_id: string;
  event_type: string;
  tool_name: string;
  detail: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AgentResultReport {
  task_id: string;
  title: string;
  status: AgentTaskStatus;
  completed_steps: number;
  total_steps: number;
  failed_steps: number;
  pending_approvals: number;
  summary: string;
  artifacts_created: Array<{ path: string; bytes: number }>;
  step_outcomes: Array<{
    step_index: number;
    title: string;
    tool_name: string;
    status: string;
    summary: string;
    error?: string;
  }>;
}

export interface AgentTaskDetail {
  task: AgentTaskSummary;
  steps: AgentTaskStep[];
  report: AgentResultReport;
  history: AgentExecutionHistoryItem[];
}

export interface LaboratoryItem {
  id: string;
  kind: 'prompt_template' | 'tokenizer_test' | 'schema_check';
  name: string;
  content: string;
  schema_json: string;
  metrics: Record<string, string | number | boolean>;
  created_at: string;
  updated_at: string;
}

export interface CreatorArtifact {
  id: string;
  title: string;
  artifact_type: 'markdown' | 'code' | 'json' | 'blueprint';
  language: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type SupportedCodeLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'html'
  | 'css'
  | 'c'
  | 'cpp';

export interface CreatorProject {
  id: string;
  name: string;
  description: string;
  workspace_type: 'coding' | 'documents' | 'presentations' | 'mixed';
  linked_research_id: string | null;
  file_count?: number;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreatorProjectFile {
  id: string;
  project_id: string;
  filename: string;
  kind: 'code' | 'document' | 'presentation';
  format: string;
  content: string;
  metadata?: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreatorRevision {
  id: string;
  file_id: string;
  project_id: string;
  version: number;
  summary: string;
  content: string;
  created_at: string;
}

export interface CodeDiagnostic {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule: string;
}

export interface CodeAnalysisResult {
  language: SupportedCodeLanguage;
  metrics: {
    lines: number;
    non_empty_lines: number;
    comment_lines: number;
    bytes: number;
    baseline_tokens: number;
    symbols_detected: string[];
    max_nesting_depth: number;
  };
  diagnostics: CodeDiagnostic[];
  explanation: string[];
  refactoring_suggestions: string[];
  sandbox_runnable: boolean;
}

export interface RestrictedCodeRunResult {
  ok: boolean;
  requires_approval?: boolean;
  stdout: string[];
  result: string;
  duration_ms: number;
  error?: string;
}

export type SlideLayout =
  | 'title'
  | 'title_content'
  | 'two_column'
  | 'diagram'
  | 'comparison'
  | 'section';

export type PresentationThemeId =
  | 'genesis_dark'
  | 'midnight_slate'
  | 'executive_light'
  | 'blueprint_blue';

export interface SlideDiagramNode {
  id: string;
  label: string;
  role?: string;
}

export interface SlideDiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface SlideImageAttachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  dataUrl: string;
}

export interface PresentationSlide {
  id: string;
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  bullets: string[];
  right_title?: string;
  right_bullets?: string[];
  notes?: string;
  image?: SlideImageAttachment;
  diagram?: {
    kind: 'architecture' | 'flow' | 'matrix';
    nodes: SlideDiagramNode[];
    edges: SlideDiagramEdge[];
  };
}

export interface PresentationDeck {
  title: string;
  subtitle: string;
  author: string;
  theme: PresentationThemeId;
  slides: PresentationSlide[];
}

export interface CreatorAssistResponse {
  mode: 'local_inference' | 'demo';
  model_name: string;
  inference_output: string | null;
  inference_error: string | null;
  deterministic_summary: string;
  suggested_draft?: string;
  suggested_deck?: PresentationDeck;
  code_analysis?: CodeAnalysisResult;
  context_used: {
    retrieval_backend: string;
    memories: Array<{ id: string; title: string; category: string }>;
    knowledge: Array<{ document_id: string; document_title: string; chunk_index: number }>;
    research_title: string | null;
    laboratory_template: string | null;
  };
}

export interface SystemSettings {
  operator_name: string;
  local_auth_enabled: boolean;
  has_passcode: boolean;
  inference_endpoint_url: string;
  prefer_local_inference: boolean;
  active_model_id: string;
  chat_use_memory: boolean;
  chat_use_knowledge: boolean;
  inference_temperature: number;
  inference_max_tokens: number;
  inference_timeout_ms: number;
  max_upload_mb: number;
  allowed_extensions: string[];
  sandbox_strict_mode: boolean;
  voice_sample_rate: number;
  voice_vad_threshold: number;
  voice_stt_adapter: string;
  voice_tts_adapter: string;
  voice_stt_language: string;
  voice_tts_voice: string;
  voice_tts_rate: number;
  voice_auto_speak: boolean;
  voice_stt_endpoint_url: string;
  voice_tts_endpoint_url: string;
  vision_endpoint_url: string;
  ocr_enabled: boolean;
  first_run_completed?: boolean;
}

export interface StreamStartPayload {
  user_message: Message;
  model_id: string;
  context_tokens_estimated?: number;
  truncated_messages?: number;
  memory_retrieval?: MemoryRetrievalSummary;
}

export interface StreamDeltaPayload {
  delta: string;
  accumulated_length: number;
  model_name?: string;
}

export interface StreamDonePayload {
  assistant_message: Message;
}

export interface StreamErrorPayload {
  error: string;
  assistant_message?: Message;
}

export interface AuthStatusResponse {
  local_auth_enabled: boolean;
  has_passcode: boolean;
  operator_name: string;
  authenticated: boolean;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  stage: string;
  runtime: string;
  uptime_sec?: number;
  database: {
    connected: boolean;
    engine: string;
    path: string;
  };
  hardware: {
    platform: string;
    arch: string;
    cpu_model: string;
    cpu_cores: number;
    total_memory_gb: number;
    free_memory_gb: number;
    process_rss_mb?: number;
    process_heap_mb?: number;
  };
  deployment?: {
    host_binding: string;
    lan_exposed: boolean;
    windows_16gb_ram_compatible: boolean;
    local_gpu_required: boolean;
  };
  reliability?: {
    error_count: number;
    warn_count: number;
    last_error_at: string | null;
  };
  model_inference: {
    mode: 'demo';
    active_model: string | null;
    external_ai_apis_disabled: boolean;
  };
  timestamp: string;
}

export interface DatabaseIntegrityReport {
  ok: boolean;
  integrity_check: string[];
  foreign_key_violations: number;
  journal_mode: string;
  db_path: string;
  db_size_bytes: number;
  fts5_enabled: boolean;
  migrations_applied: Array<{ version: string; description: string; applied_at: string }>;
  table_counts: Record<string, number>;
  checked_at: string;
}

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  detail?: string;
}

export interface SystemLogsResponse {
  summary: {
    total_buffered: number;
    error_count: number;
    warn_count: number;
    last_error_at: string | null;
    log_file_path: string;
  };
  logs: SystemLogEntry[];
}

export interface TokenBreakdown {
  token_count: number;
  char_count: number;
  byte_count: number;
  word_count: number;
  estimated_context_pct: number;
  tokens: Array<{ index: number; text: string; bytes: number; id: number }>;
}

export interface GenesisCorePresetSummary {
  vocab_size: number;
  context_length: number;
  d_model: number;
  n_heads: number;
  n_layers: number;
  estimated_parameters?: number;
}

export interface GenesisCoreStatusResponse {
  experimental: true;
  torch_available: boolean;
  runtime_note?: string;
  trained: boolean;
  model_status: 'untrained_experimental' | 'experimental_trained';
  trained_steps: number;
  train_loss: number | null;
  val_loss: number | null;
  checkpoint_path: string;
  checkpoint_exists: boolean;
  checkpoint_size_bytes?: number;
  tokenizer_path: string;
  tokenizer_exists: boolean;
  tokenizer_vocab_size?: number | null;
  model_config?: Record<string, unknown> | null;
  ram_budget_note?: string;
  capabilities?: {
    operational: string[];
    experimental_untrained: string[];
  };
  architecture: {
    class_name: string;
    tokenizer_class: string;
    presets: Record<string, GenesisCorePresetSummary>;
  };
  training_command: string;
}

export interface MultimodalStatusResponse {
  ffmpeg_available: boolean;
  ocr_enabled: boolean;
  tesseract_engine: string;
  cached_tessdata_languages: string[];
  stt_endpoint_configured: boolean;
  tts_endpoint_configured: boolean;
  vision_endpoint_configured: boolean;
  temp_files_pending: number;
  supported_formats: {
    images: string[];
    documents: string[];
    audio: string[];
  };
}

export interface OcrResultPayload {
  ok: boolean;
  engine: 'tesseract.js' | 'disabled';
  language: string;
  text: string;
  confidence: number;
  blocks: Array<{ text: string; confidence: number }>;
  error?: string;
}

export interface ImageAnalysisPayload {
  ok: boolean;
  mode: 'local_vision_http' | 'local_ocr_and_heuristics';
  filename: string;
  metrics: {
    format: 'png' | 'jpeg' | 'webp';
    width: number;
    height: number;
    aspect_ratio: string;
    byte_size: number;
    mean_brightness: number;
    contrast_stddev: number;
    light_pixel_ratio: number;
    dark_pixel_ratio: number;
    edge_density: number;
    color_variance: number;
    classification: string;
  };
  ocr: OcrResultPayload;
  description: string;
  vqa_answer?: string | null;
  vqa_model_name?: string | null;
  vqa_note?: string | null;
}

export interface DocumentExtractionPayload {
  ok: boolean;
  format: 'pdf' | 'docx' | 'txt' | 'md';
  filename: string;
  extracted_text: string;
  page_count?: number;
  metrics: {
    chars: number;
    words: number;
    lines: number;
    headings: number;
    lists: number;
    tables: number;
    code_blocks: number;
  };
  note?: string;
}

export interface SpeechTranscribePayload {
  ok: boolean;
  mode: 'local_whisper_http' | 'acoustic_only_no_stt_server';
  transcript: string;
  language: string;
  acoustic: {
    format: string;
    duration_sec: number | null;
    sample_rate: number | null;
    channels: number | null;
    codec: string | null;
    byte_size: number;
    ffmpeg_available: boolean;
  };
  message: string;
}

export interface SpeechSynthesizePayload {
  ok: boolean;
  mode: 'local_piper_http' | 'browser_tts_fallback';
  mimeType?: string;
  audioBase64?: string;
  message: string;
}

export interface MultimodalProcessResponse {
  ok: boolean;
  asset_id?: string;
  asset_kind: 'image' | 'document' | 'audio';
  filename: string;
  mimeType: string;
  extension: string;
  size: number;
  summary: string;
  extracted_text: string;
  image_data_url?: string;
  image_analysis?: ImageAnalysisPayload;
  document_extraction?: DocumentExtractionPayload;
  speech_result?: SpeechTranscribePayload;
  attachment: AttachmentMeta;
}

// Step 11: Engineering & Scientific Intelligence
export type EngineeringDisciplineId =
  | 'mechanical'
  | 'electrical'
  | 'civil'
  | 'computer_science'
  | 'manufacturing'
  | 'cad_3d'
  | 'fluid_power'
  | 'machine_design';

export type EngineeringCalculatorId =
  | 'stress_strain'
  | 'force_torque_power'
  | 'motion_kinematics'
  | 'thermodynamics'
  | 'fluid_flow_pressure'
  | 'pump_compressor'
  | 'gear_shaft_design'
  | 'electrical_circuits';

export type EngineeringDiagramKind =
  | 'beam_load'
  | 'shaft_step'
  | 'pressure_vessel'
  | 'rlc_circuit'
  | 'pipe_system';

export interface EngineeringPlotSpec {
  title: string;
  x_label: string;
  y_label: string;
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  series: Array<{ id: string; label: string; color: string; points: Array<{ x: number; y: number }> }>;
  markers?: Array<{ x: number; y: number; label: string; color?: string }>;
}

export interface EngineeringStatusResponse {
  operational: boolean;
  calculators: EngineeringCalculatorId[];
  math_operations: string[];
  diagram_kinds: EngineeringDiagramKind[];
  disciplines_count: number;
  materials_count: number;
  unit_categories: Array<{
    id: string;
    label: string;
    si_base: string;
    units: Array<{ symbol: string; label: string }>;
  }>;
  simulation_tools: Array<{
    id: string;
    name: string;
    runtime: string;
    available: boolean;
    version: string | null;
    status_note: string;
  }>;
  safety_notice: string;
}

export interface EngineeringCalculationResponse {
  ok: boolean;
  calculator: EngineeringCalculatorId;
  title: string;
  inputs_si: Record<string, { value: number; unit: string }>;
  outputs: Array<{
    key: string;
    label: string;
    value: number;
    unit: string;
    formatted: string;
    kind: string;
    reference_note?: string;
  }>;
  steps: Array<{ label: string; formula: string; substitution: string; result: string }>;
  assumptions: string[];
  limitations: string[];
  independent_check: { passed: boolean; method: string; detail: string };
  warnings: Array<{ severity: 'info' | 'warning' | 'critical'; code: string; message: string }>;
  safety_notice: string;
}

export interface MathComputationResponse {
  ok: boolean;
  operation: string;
  summary: string;
  result_value: string | number | Record<string, unknown>;
  steps: string[];
  verification?: { passed: boolean; method: string; residual?: number; detail: string };
  warnings: string[];
  chart?: EngineeringPlotSpec;
}

export interface EngineeringDiagramResponse {
  ok: boolean;
  kind: EngineeringDiagramKind;
  title: string;
  svg: string;
  dimensions: Array<{ callout: string; value: string; tolerance?: string }>;
  cad_guidance: string[];
  drawing_notes: string[];
  interpretation?: {
    detected_standards: string[];
    detected_tolerances: string[];
    detected_dimensions: string[];
    summary: string;
  };
}

export interface DisciplineReferenceItem {
  id: EngineeringDisciplineId;
  name: string;
  overview: string;
  core_principles: string[];
  key_formulas: Array<{ name: string; equation: string; variables: string }>;
  assumptions: string[];
  worked_example: { problem: string; given: string[]; steps: string[]; answer: string };
  practical_applications: string[];
}

export interface EngineeringMaterialItem {
  id: string;
  name: string;
  category: string;
  density_kg_m3: number;
  youngs_modulus_gpa: number;
  yield_strength_mpa: number;
  ultimate_strength_mpa: number;
  poissons_ratio: number;
  thermal_conductivity_w_mk: number;
  notes: string;
}

export interface ScientificExperimentItem {
  id: string;
  title: string;
  discipline: EngineeringDisciplineId;
  objective: string;
  established_facts: string[];
  assumptions: string[];
  hypothesis: string;
  experimental_plan: string;
  observations: Array<{
    id: string;
    label: string;
    x_value: number;
    theoretical_value: number;
    experimental_value: number;
    unit: string;
  }>;
  analysis_summary: string;
  sources: Array<{ title: string; reference: string; reliability: 'established_standard' | 'peer_reviewed' | 'preliminary_note' }>;
  status: 'planned' | 'in_progress' | 'analyzed' | 'concluded';
  comparison?: {
    count: number;
    mean_abs_error: number;
    mean_pct_error: number;
    max_pct_error: number;
    rmse: number;
    rows: Array<{
      id: string;
      label: string;
      x_value: number;
      theoretical_value: number;
      experimental_value: number;
      unit: string;
      residual: number;
      abs_error: number;
      pct_error: number | null;
    }>;
    summary: string;
  };
  created_at: string;
  updated_at: string;
}

export interface SimulationRunResponse {
  ok: boolean;
  runtime: string;
  approved: boolean;
  duration_ms: number;
  stdout: string;
  parsed_json?: Record<string, unknown> | null;
  chart?: EngineeringPlotSpec;
  error?: string;
  resource_limits: {
    timeout_ms: number;
    max_stdout_bytes: number;
    isolated_mode: boolean;
  };
}



