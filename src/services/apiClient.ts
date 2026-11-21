import type {
  AgentBlueprint,
  AgentExecutionHistoryItem,
  AgentTaskDetail,
  AgentTaskSummary,
  AgentToolDescriptor,
  AttachmentMeta,
  AuthStatusResponse,
  CodeAnalysisResult,
  Conversation,
  ConversationSearchHit,
  CreatorArtifact,
  CreatorAssistResponse,
  CreatorProject,
  CreatorProjectFile,
  CreatorRevision,
  DatabaseIntegrityReport,
  DisciplineReferenceItem,
  EngineeringCalculationResponse,
  EngineeringCalculatorId,
  EngineeringDiagramKind,
  EngineeringDiagramResponse,
  EngineeringDisciplineId,
  EngineeringMaterialItem,
  EngineeringStatusResponse,
  GenesisCoreStatusResponse,
  HealthResponse,
  ImageAnalysisPayload,
  KnowledgeDocument,
  LaboratoryItem,
  MathComputationResponse,
  MemoryEntry,
  MemorySystemStatus,
  Message,
  ModelEntry,
  MultimodalProcessResponse,
  MultimodalStatusResponse,
  PresentationDeck,
  ResearchProject,
  RestrictedCodeRunResult,
  RetrievalQueryResponse,
  ScientificExperimentItem,
  SimulationRunResponse,
  SpeechSynthesizePayload,
  SpeechTranscribePayload,
  StreamDeltaPayload,
  StreamDonePayload,
  StreamErrorPayload,
  StreamStartPayload,
  SystemLogsResponse,
  SystemSettings,
  TokenBreakdown,
  WorldProviderDescriptor,
  WorldSearchResponse,
  WorldUrlFetchResponse,
} from '../types/genesis';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly existingName?: string;
  constructor(message: string, status: number, code?: string, existingName?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.existingName = existingName;
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

// Security hygiene: hold Bearer tokens strictly in JS memory (paired with HttpOnly session cookie).
let inMemorySessionToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

function readStoredToken(): string | null {
  return inMemorySessionToken;
}

export function setSessionToken(token: string | null): void {
  inMemorySessionToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = readStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) || {}),
  };
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}/api${path}`, {
    credentials: 'include',
    ...options,
    headers,
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/settings/verify-passcode')) {
      setSessionToken(null);
      unauthorizedHandler?.();
    }
    const message =
      (data && (data.error || data.detail)) || `Request failed with HTTP ${res.status}`;
    throw new ApiRequestError(
      message,
      res.status,
      data && typeof data.code === 'string' ? data.code : undefined,
      data && typeof data.existing_name === 'string' ? data.existing_name : undefined
    );
  }

  return data as T;
}

export const apiClient = {
  getHealth: () => request<HealthResponse>('/health'),
  getGenesisCoreStatus: () => request<GenesisCoreStatusResponse>('/genesis-core/status'),

  // Conversations & Messages
  listConversations: () => request<Conversation[]>('/conversations'),
  createConversation: (payload: { title?: string; module?: string; model_id?: string | null }) =>
    request<Conversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateConversation: (id: string, payload: { title?: string; model_id?: string | null }) =>
    request<Conversation>(`/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  renameConversation: (id: string, title: string) =>
    request<Conversation>(`/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  searchConversations: (q: string, limit = 20) => {
    const search = new URLSearchParams();
    search.set('q', q);
    search.set('limit', String(limit));
    return request<{ query: string; matches: ConversationSearchHit[] }>(
      `/conversations/search?${search.toString()}`
    );
  },
  listMessages: (conversationId: string) =>
    request<Message[]>(`/conversations/${encodeURIComponent(conversationId)}/messages`),
  sendMessage: (
    conversationId: string,
    payload: {
      content: string;
      attachments: AttachmentMeta[];
      model_id?: string | null;
      temperature?: number;
      max_tokens?: number;
      timeout_ms?: number;
      use_memory?: boolean;
      use_knowledge?: boolean;
    }
  ) =>
    request<{ user_message: Message; assistant_message: Message }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  sendMessageStream: async (
    conversationId: string,
    payload: {
      content: string;
      attachments: AttachmentMeta[];
      model_id?: string | null;
      temperature?: number;
      max_tokens?: number;
      timeout_ms?: number;
      use_memory?: boolean;
      use_knowledge?: boolean;
    },
    callbacks: {
      onStart?: (data: StreamStartPayload) => void;
      onDelta?: (data: StreamDeltaPayload) => void;
      onDone?: (data: StreamDonePayload) => void;
      onError?: (data: StreamErrorPayload) => void;
    },
    signal?: AbortSignal
  ): Promise<void> => {
    const token = readStoredToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(payload),
        signal,
      }
    );

    if (!res.ok) {
      if (res.status === 401) {
        setSessionToken(null);
        unauthorizedHandler?.();
      }
      const isJson = res.headers.get('content-type')?.includes('application/json');
      const errData = isJson ? await res.json().catch(() => null) : null;
      throw new Error((errData && (errData.error || errData.detail)) || `Stream request failed with HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new Error('Server response stream unavailable.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const dispatchFrame = (frame: string) => {
      const lines = frame.split(/\r?\n/);
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) return;
      const rawData = dataLines.join('\n');
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return;
      }

      if (eventName === 'start') {
        callbacks.onStart?.(parsed as StreamStartPayload);
      } else if (eventName === 'delta') {
        callbacks.onDelta?.(parsed as StreamDeltaPayload);
      } else if (eventName === 'done') {
        callbacks.onDone?.(parsed as StreamDonePayload);
      } else if (eventName === 'error') {
        callbacks.onError?.(parsed as StreamErrorPayload);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (frame.trim()) dispatchFrame(frame);
      }
    }
    if (buffer.trim()) {
      dispatchFrame(buffer);
    }
  },
  validateAttachment: (payload: {
    name: string;
    size: number;
    mimeType: string;
    previewText?: string;
  }) =>
    request<AttachmentMeta>('/upload/validate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Memory & Knowledge System
  getMemoryStatus: () => request<MemorySystemStatus>('/memory/status'),
  listMemory: (params?: { namespace?: string; category?: string; q?: string }) => {
    const search = new URLSearchParams();
    if (params?.namespace && params.namespace !== 'all') search.set('namespace', params.namespace);
    if (params?.category && params.category !== 'all') search.set('category', params.category);
    if (params?.q) search.set('q', params.q);
    const qs = search.toString();
    return request<MemoryEntry[]>(`/memory${qs ? `?${qs}` : ''}`);
  },
  createMemory: (payload: {
    namespace: string;
    category?: string;
    title: string;
    content: string;
    tags: string[];
    importance: number;
    approved?: boolean;
    source_conversation_id?: string | null;
  }) =>
    request<MemoryEntry>('/memory', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateMemory: (
    id: string,
    payload: {
      namespace?: string;
      category?: string;
      title?: string;
      content?: string;
      tags?: string[];
      importance?: number;
    }
  ) =>
    request<MemoryEntry>(`/memory/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteMemory: (id: string) =>
    request<{ deleted: boolean }>(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Knowledge Base
  listKnowledge: (params?: { source_type?: string; q?: string }) => {
    const search = new URLSearchParams();
    if (params?.source_type && params.source_type !== 'all') {
      search.set('source_type', params.source_type);
    }
    if (params?.q) search.set('q', params.q);
    const qs = search.toString();
    return request<KnowledgeDocument[]>(`/knowledge${qs ? `?${qs}` : ''}`);
  },
  getKnowledgeDocument: (id: string) =>
    request<KnowledgeDocument>(`/knowledge/${encodeURIComponent(id)}`),
  createKnowledge: (payload: {
    title: string;
    source_type: string;
    source_name?: string;
    content: string;
    tags: string[];
  }) =>
    request<KnowledgeDocument>('/knowledge', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateKnowledge: (
    id: string,
    payload: {
      title?: string;
      source_type?: string;
      source_name?: string;
      content?: string;
      tags?: string[];
    }
  ) =>
    request<KnowledgeDocument>(`/knowledge/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteKnowledge: (id: string) =>
    request<{ deleted: boolean }>(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  queryRetrieval: (payload: {
    query: string;
    include_memory?: boolean;
    include_knowledge?: boolean;
    max_memory_items?: number;
    max_knowledge_chunks?: number;
  }) =>
    request<RetrievalQueryResponse>('/retrieval/query', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Research
  listResearch: () => request<ResearchProject[]>('/research'),
  createResearch: (payload: Omit<ResearchProject, 'id' | 'created_at' | 'updated_at'>) =>
    request<ResearchProject>('/research', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateResearch: (
    id: string,
    payload: Omit<ResearchProject, 'id' | 'created_at' | 'updated_at'>
  ) =>
    request<ResearchProject>(`/research/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteResearch: (id: string) =>
    request<{ deleted: boolean }>(`/research/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getWorldProviders: () =>
    request<{
      providers: WorldProviderDescriptor[];
      direct_url_modes: string[];
      ssrf_protection: boolean;
      rate_limit_per_minute: number;
    }>('/research/world/providers'),
  searchWorldSources: (payload: { provider: 'wikipedia' | 'arxiv'; query: string; limit?: number }) =>
    request<WorldSearchResponse>('/research/world/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  fetchWorldUrl: (url: string) =>
    request<WorldUrlFetchResponse>('/research/world/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  // Models
  listModels: () => request<ModelEntry[]>('/models'),
  registerModel: (payload: {
    name: string;
    provider: string;
    model_type: string;
    local_path: string;
    endpoint_url: string;
    context_length: number;
    quantization: string;
    parameter_count: string;
    notes?: string;
  }) =>
    request<ModelEntry>('/models', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateModel: (
    id: string,
    payload: { name?: string; local_path?: string; endpoint_url?: string; context_length?: number }
  ) =>
    request<ModelEntry>(`/models/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  probeModel: (id: string) =>
    request<{
      id: string;
      reachable: boolean;
      status: string;
      loading_status: string;
      detected_models?: string[];
      server_model?: string | null;
      message: string;
    }>(`/models/${encodeURIComponent(id)}/probe`, { method: 'POST' }),
  deleteModel: (id: string) =>
    request<{ deleted: boolean }>(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Agents
  listAgents: () => request<AgentBlueprint[]>('/agents'),
  createAgent: (payload: {
    name: string;
    role: string;
    description: string;
    allowed_tools: string[];
    sandbox_policy: Record<string, unknown>;
    system_prompt: string;
  }) =>
    request<AgentBlueprint>('/agents', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  dryRunAgent: (id: string, task: string) =>
    request<{
      agent_id: string;
      agent_name: string;
      mode: string;
      trace: Array<{ step: number; action: string; status: string; detail: string }>;
    }>(`/agents/${encodeURIComponent(id)}/dry-run`, {
      method: 'POST',
      body: JSON.stringify({ task }),
    }),
  deleteAgent: (id: string) =>
    request<{ deleted: boolean }>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Step 07: Agent OS Tasks, Tools, Approvals & History
  listAgentTools: () => request<AgentToolDescriptor[]>('/agent-tools'),
  listAgentTasks: (status?: string) => {
    const qs = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
    return request<AgentTaskSummary[]>(`/agent-tasks${qs}`);
  },
  createAgentTask: (payload: {
    agent_id: string;
    goal: string;
    title?: string;
    target_file_path?: string;
    document_filename?: string;
    code_snippet?: string;
    max_retries?: number;
    auto_run?: boolean;
  }) =>
    request<AgentTaskDetail>('/agent-tasks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAgentTask: (id: string) => request<AgentTaskDetail>(`/agent-tasks/${encodeURIComponent(id)}`),
  runAgentTask: (id: string) =>
    request<AgentTaskDetail>(`/agent-tasks/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  approveAgentTaskStep: (
    taskId: string,
    stepId: string,
    payload: { approved: boolean; note?: string; resume?: boolean }
  ) =>
    request<AgentTaskDetail>(
      `/agent-tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  cancelAgentTask: (id: string) =>
    request<AgentTaskDetail>(`/agent-tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  saveAgentTaskMemory: (
    id: string,
    payload: {
      approved: boolean;
      title?: string;
      content?: string;
      category?: string;
      tags?: string[];
    }
  ) =>
    request<{ id: string; title: string; category: string; content: string }>(
      `/agent-tasks/${encodeURIComponent(id)}/save-memory`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  deleteAgentTask: (id: string) =>
    request<{ deleted: boolean }>(`/agent-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listAgentHistory: (params?: { task_id?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.task_id) search.set('task_id', params.task_id);
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<AgentExecutionHistoryItem[]>(`/agent-history${qs ? `?${qs}` : ''}`);
  },

  // Laboratory
  tokenize: (text: string, context_limit = 8192) =>
    request<TokenBreakdown>('/laboratory/tokenize', {
      method: 'POST',
      body: JSON.stringify({ text, context_limit }),
    }),
  listLaboratory: () => request<LaboratoryItem[]>('/laboratory'),
  createLaboratoryItem: (payload: {
    kind: string;
    name: string;
    content: string;
    schema_json: string;
    metrics: Record<string, unknown>;
  }) =>
    request<LaboratoryItem>('/laboratory', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteLaboratoryItem: (id: string) =>
    request<{ deleted: boolean }>(`/laboratory/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Creator
  listCreator: () => request<CreatorArtifact[]>('/creator'),
  createArtifact: (payload: {
    title: string;
    artifact_type: string;
    language: string;
    content: string;
  }) =>
    request<CreatorArtifact>('/creator', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateArtifact: (
    id: string,
    payload: { title: string; artifact_type: string; language: string; content: string }
  ) =>
    request<CreatorArtifact>(`/creator/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteArtifact: (id: string) =>
    request<{ deleted: boolean }>(`/creator/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Step 09: Creator Studio Workspaces
  listCreatorProjects: () => request<CreatorProject[]>('/creator/projects'),
  createCreatorProject: (payload: {
    name: string;
    description?: string;
    workspace_type?: string;
    linked_research_id?: string | null;
  }) =>
    request<CreatorProject>('/creator/projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCreatorProject: (
    id: string,
    payload: { name?: string; description?: string; linked_research_id?: string | null }
  ) =>
    request<CreatorProject>(`/creator/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteCreatorProject: (id: string) =>
    request<{ deleted: boolean }>(`/creator/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  listCreatorFiles: (projectId: string) =>
    request<CreatorProjectFile[]>(`/creator/projects/${encodeURIComponent(projectId)}/files`),
  createCreatorFile: (
    projectId: string,
    payload: {
      filename: string;
      kind?: 'code' | 'document' | 'presentation';
      format?: string;
      content?: string;
      summary?: string;
      overwrite?: boolean;
      metadata?: Record<string, unknown>;
    }
  ) =>
    request<CreatorProjectFile>(`/creator/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCreatorFile: (
    fileId: string,
    payload: {
      filename?: string;
      format?: string;
      content?: string;
      summary?: string;
      overwrite?: boolean;
      metadata?: Record<string, unknown>;
    }
  ) =>
    request<CreatorProjectFile>(`/creator/files/${encodeURIComponent(fileId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteCreatorFile: (fileId: string) =>
    request<{ deleted: boolean }>(`/creator/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    }),
  listCreatorRevisions: (fileId: string) =>
    request<CreatorRevision[]>(`/creator/files/${encodeURIComponent(fileId)}/revisions`),
  restoreCreatorRevision: (fileId: string, revisionId: string) =>
    request<CreatorProjectFile>(
      `/creator/files/${encodeURIComponent(fileId)}/restore/${encodeURIComponent(revisionId)}`,
      { method: 'POST' }
    ),
  uploadCreatorFile: (payload: {
    project_id: string;
    filename: string;
    encoding: 'utf8' | 'base64';
    data: string;
    overwrite?: boolean;
  }) =>
    request<
      | { type: 'project_file'; file: CreatorProjectFile }
      | { type: 'image_asset'; name: string; mimeType: 'image/png' | 'image/jpeg'; size: number; dataUrl: string }
    >('/creator/upload', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  exportCreatorBlob: async (payload: {
    project_id?: string;
    title: string;
    filename?: string;
    export_format: string;
    content?: string;
    deck?: PresentationDeck;
    save_to_workspace?: boolean;
    overwrite?: boolean;
  }): Promise<{ blob: Blob; filename: string }> => {
    const token = readStoredToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/creator/export`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      if (res.status === 401) {
        setSessionToken(null);
        unauthorizedHandler?.();
      }
      const data = await res.json().catch(() => null);
      throw new ApiRequestError(
        (data && (data.error || data.detail)) || `Export failed with HTTP ${res.status}`,
        res.status,
        data && typeof data.code === 'string' ? data.code : undefined,
        data && typeof data.existing_name === 'string' ? data.existing_name : undefined
      );
    }
    const disposition = res.headers.get('content-disposition') || '';
    const nameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = nameMatch?.[1] || `${payload.title}.${payload.export_format}`;
    return { blob: await res.blob(), filename };
  },
  analyzeCreatorCode: (language: string, code: string) =>
    request<CodeAnalysisResult>('/creator/code/analyze', {
      method: 'POST',
      body: JSON.stringify({ language, code }),
    }),
  runCreatorCode: (language: string, code: string, approved: boolean) =>
    request<RestrictedCodeRunResult>('/creator/code/run', {
      method: 'POST',
      body: JSON.stringify({ language, code, approved }),
    }),
  creatorAssist: (payload: {
    workspace: 'coding' | 'documents' | 'presentations';
    action: string;
    language?: string;
    title?: string;
    content?: string;
    goal?: string;
    use_memory?: boolean;
    use_knowledge?: boolean;
    research_id?: string | null;
    laboratory_item_id?: string | null;
  }) =>
    request<CreatorAssistResponse>('/creator/assist', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  saveCreatorFileToMemory: (
    fileId: string,
    payload: { approved: boolean; title?: string; category?: string; namespace?: string }
  ) =>
    request<{ id: string; title: string }>(`/creator/files/${encodeURIComponent(fileId)}/save-memory`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  saveCreatorFileToKnowledge: (fileId: string, payload: { title?: string; tags?: string[] }) =>
    request<{ id: string; title: string; chunk_count: number }>(
      `/creator/files/${encodeURIComponent(fileId)}/save-knowledge`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  dispatchCreatorFileToAgent: (fileId: string, payload: { agent_id?: string; goal?: string }) =>
    request<AgentTaskDetail>(`/creator/files/${encodeURIComponent(fileId)}/dispatch-agent`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Step 10: Voice, Vision & Multimodal Intelligence
  getMultimodalStatus: () => request<MultimodalStatusResponse>('/multimodal/status'),
  processMultimodalFile: (payload: {
    filename: string;
    mimeType?: string;
    encoding?: 'base64' | 'utf8';
    data: string;
    question?: string;
    ocr_enabled?: boolean;
    language?: string;
    save_asset?: boolean;
  }) =>
    request<MultimodalProcessResponse>('/multimodal/process', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  analyzeMultimodalImage: (payload: {
    filename: string;
    mimeType?: string;
    dataBase64: string;
    question?: string;
    ocr_enabled?: boolean;
    ocr_language?: string;
  }) =>
    request<ImageAnalysisPayload>('/multimodal/analyze-image', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  transcribeAudio: (payload: {
    filename: string;
    mimeType?: string;
    dataBase64: string;
    language?: string;
  }) =>
    request<SpeechTranscribePayload>('/multimodal/transcribe', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  synthesizeSpeech: (payload: { text: string; voice?: string; speed?: number }) =>
    request<SpeechSynthesizePayload>('/multimodal/synthesize', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  sendMediaToResearch: (payload: {
    research_id?: string | null;
    title?: string;
    summary?: string;
    source_name: string;
    content: string;
    tags?: string[];
  }) =>
    request<{ action: 'created' | 'appended'; id: string; title: string; sources_count: number }>(
      '/multimodal/send-to-research',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  sendMediaToCreator: (payload: {
    project_id?: string;
    filename: string;
    content: string;
    overwrite?: boolean;
    summary?: string;
  }) =>
    request<{ file: CreatorProjectFile; project_name: string }>('/multimodal/send-to-creator', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Step 11: Engineering & Scientific Intelligence
  getEngineeringStatus: () => request<EngineeringStatusResponse>('/engineering/status'),
  getEngineeringDisciplines: () =>
    request<{ disciplines: DisciplineReferenceItem[]; materials: EngineeringMaterialItem[] }>(
      '/engineering/disciplines'
    ),
  explainDiscipline: (payload: {
    discipline_id: EngineeringDisciplineId;
    question: string;
    model_id?: string | null;
  }) =>
    request<{ mode: string; explanation: string; model_name?: string; context_used?: { memories: number; knowledge: number } }>(
      '/engineering/disciplines/explain',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  convertUnits: (payload: { value: number; from_unit: string; to_unit: string }) =>
    request<{ ok: boolean; output_value: number; formatted: string; conversion_note: string }>(
      '/engineering/convert-units',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  runEngineeringCalculation: (payload: {
    calculator: EngineeringCalculatorId;
    inputs: Record<string, { value: number; unit?: string } | number>;
    save_history?: boolean;
  }) =>
    request<EngineeringCalculationResponse>('/engineering/calculate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  runMathOperation: (payload: { operation: string; params: Record<string, unknown> }) =>
    request<MathComputationResponse>('/engineering/math', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateEngineeringDiagram: (payload: {
    kind: EngineeringDiagramKind;
    params: Record<string, unknown>;
    drawing_notes?: string;
  }) =>
    request<EngineeringDiagramResponse>('/engineering/design/diagram', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSimulationPresets: () =>
    request<{
      capabilities: EngineeringStatusResponse['simulation_tools'];
      presets: Array<{ id: string; title: string; description: string; code: string }>;
    }>('/engineering/simulate/presets'),
  runEngineeringSimulation: (payload: { code: string; approved: boolean; timeout_ms?: number }) =>
    request<SimulationRunResponse>('/engineering/simulate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  listExperiments: () => request<ScientificExperimentItem[]>('/engineering/experiments'),
  createExperiment: (payload: Partial<ScientificExperimentItem>) =>
    request<ScientificExperimentItem>('/engineering/experiments', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateExperiment: (id: string, payload: Partial<ScientificExperimentItem>) =>
    request<ScientificExperimentItem>(`/engineering/experiments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteExperiment: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/engineering/experiments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  exportEngineeringReport: async (payload: {
    title: string;
    format: 'pdf' | 'docx' | 'md' | 'txt' | 'svg';
    markdown_content?: string;
    svg_content?: string;
  }): Promise<{ blob: Blob; filename: string }> => {
    const token = readStoredToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/engineering/export-report`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiRequestError(errJson?.error || `Export failed (HTTP ${res.status})`, res.status);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    return {
      blob: await res.blob(),
      filename: match?.[1] || `engineering_report.${payload.format}`,
    };
  },
  saveEngineeringToMemory: (payload: { title: string; content: string; tags?: string[]; approved: boolean }) =>
    request<{ id: string; title: string }>('/engineering/integrate/memory', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  saveEngineeringToKnowledge: (payload: { title: string; source_name?: string; content: string; tags?: string[] }) =>
    request<{ id: string; title: string; chunk_count: number }>('/engineering/integrate/knowledge', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  saveEngineeringToResearch: (payload: { title: string; summary?: string; notes: string; tags?: string[] }) =>
    request<{ id: string; title: string }>('/engineering/integrate/research', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  saveEngineeringToCreator: (payload: {
    project_id?: string;
    filename: string;
    content: string;
    overwrite?: boolean;
    summary?: string;
  }) =>
    request<{ file: CreatorProjectFile; project_name: string }>('/engineering/integrate/creator', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  dispatchEngineeringAgent: (payload: { goal: string; agent_id?: string; report_summary?: string }) =>
    request<AgentTaskDetail>('/engineering/integrate/agent', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Auth, Settings & Security
  getAuthStatus: () => request<AuthStatusResponse>('/auth/status'),
  logout: async () => {
    try {
      return await request<{ logged_out: boolean }>('/auth/logout', { method: 'POST' });
    } finally {
      setSessionToken(null);
    }
  },
  getSettings: () => request<SystemSettings>('/settings'),
  updateSettings: async (
    payload: Partial<SystemSettings> & { new_passcode?: string; current_passcode?: string }
  ) => {
    const res = await request<
      SystemSettings & { session_token?: string; expires_at?: string }
    >('/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res.session_token) {
      setSessionToken(res.session_token);
    } else if (payload.local_auth_enabled === false) {
      setSessionToken(null);
    }
    return res;
  },
  verifyPasscode: async (passcode: string) => {
    const res = await request<{
      unlocked: boolean;
      session_token?: string;
      expires_at?: string;
    }>('/settings/verify-passcode', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    });
    if (res.session_token) {
      setSessionToken(res.session_token);
    }
    return res;
  },
  exportDatabaseSnapshot: () => request<Record<string, unknown>>('/settings/export-db'),
  exportSqliteBinaryBackup: async (): Promise<{ blob: Blob; filename: string }> => {
    const token = readStoredToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/settings/export-sqlite`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiRequestError(errJson?.error || `Binary backup failed (HTTP ${res.status})`, res.status);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    return {
      blob: await res.blob(),
      filename: match?.[1] || `genesis_backup_${new Date().toISOString().slice(0, 10)}.db`,
    };
  },
  restoreDatabaseSnapshot: (snapshot: Record<string, unknown>) =>
    request<{ restored: boolean; restored_tables: Record<string, number>; restored_at: string }>(
      '/settings/restore-db',
      {
        method: 'POST',
        body: JSON.stringify(snapshot),
      }
    ),
  completeFirstRunSetup: async (payload: {
    operator_name?: string;
    prefer_local_inference?: boolean;
    enable_local_auth?: boolean;
    new_passcode?: string;
  }) => {
    const res = await request<
      SystemSettings & { session_token?: string; expires_at?: string }
    >('/settings/first-run', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res.session_token) {
      setSessionToken(res.session_token);
    }
    return res;
  },
  runIntegrityCheck: () =>
    request<DatabaseIntegrityReport>('/system/integrity-check', { method: 'POST' }),
  getSystemLogs: (params?: { limit?: number; level?: 'all' | 'info' | 'warn' | 'error' }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.level && params.level !== 'all') qs.set('level', params.level);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<SystemLogsResponse>(`/system/logs${suffix}`);
  },
  clearSystemLogs: () => request<{ cleared: boolean }>('/system/logs', { method: 'DELETE' }),
  resetWorkspace: () => request<{ reset: boolean }>('/settings/reset', { method: 'POST' }),
};
