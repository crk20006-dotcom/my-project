import type { TokenBreakdown } from '../types/genesis';

/**
 * Provider-Independent AI Architecture Contracts
 * Designed for future integration with GENESIS CORE weights or local inference servers.
 * External proprietary LLM APIs are intentionally excluded from this contract layer.
 */

export interface ArchitectureInterfaceSpec {
  id: string;
  name: string;
  layer: 'Core Model' | 'Runtime' | 'Memory' | 'Orchestration' | 'Configuration';
  implementationStatus:
    | 'Interface Defined'
    | 'Deterministic Baseline Active'
    | 'Placeholder Adapter'
    | 'Experimental Prototype (Untrained)';
  description: string;
  pythonClass: string;
  typescriptInterface: string;
  methods: Array<{ name: string; signature: string; purpose: string }>;
}

export interface GenesisModelInterface {
  readonly modelId: string;
  readonly architecture: string;
  readonly isLoaded: boolean;
  loadWeights(localPath: string): Promise<{ loaded: boolean; reason: string }>;
  unloadWeights(): Promise<void>;
  getCapabilities(): {
    maxContextTokens: number;
    supportsStreaming: boolean;
    supportsToolCalling: boolean;
  };
}

export interface GenesisInferenceInterface {
  generate(request: {
    prompt: string;
    systemPrompt?: string;
    maxTokens: number;
    temperature: number;
    stopSequences?: string[];
  }): Promise<{
    mode: 'demo' | 'local_http' | 'genesis_core';
    text: string;
    finishReason: 'not_connected' | 'stop' | 'length' | 'error';
    usage: { promptTokens: number; completionTokens: number };
  }>;
}

export interface GenesisTokenizerInterface {
  readonly vocabularyType: string;
  encode(text: string): number[];
  decode(ids: number[]): string;
  inspect(text: string, contextLimit?: number): TokenBreakdown;
}

export interface GenesisMemoryInterface {
  store(namespace: string, title: string, content: string, tags: string[]): Promise<string>;
  query(namespace: string | null, searchTerm: string): Promise<Array<{ id: string; title: string; snippet: string }>>;
}

export interface GenesisToolExecutorInterface {
  listAllowedTools(): string[];
  validateExecution(toolName: string, args: Record<string, unknown>): { allowed: boolean; reason: string };
}

/**
 * Deterministic baseline tokenizer for local diagnostic inspection.
 * Splits text into whitespace/punctuation/subword units and computes deterministic FNV-1a token IDs.
 * Does not claim to match any proprietary model vocabulary.
 */
export function inspectTokensDeterministic(text: string, contextLimit = 8192): TokenBreakdown {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(text).length;

  if (!text) {
    return {
      token_count: 0,
      char_count: 0,
      byte_count: 0,
      word_count: 0,
      estimated_context_pct: 0,
      tokens: [],
    };
  }

  // Deterministic regex segmentation approximating subword & punctuation boundaries
  const rawSegments = text.match(/(\s+|[A-Za-z0-9]+|[^\sA-Za-z0-9]+)/g) || [];
  const subTokens: string[] = [];

  for (const seg of rawSegments) {
    if (/^\s+$/.test(seg)) {
      subTokens.push(seg);
    } else if (seg.length <= 5) {
      subTokens.push(seg);
    } else {
      for (let i = 0; i < seg.length; i += 4) {
        subTokens.push(seg.slice(i, i + 4));
      }
    }
  }

  const tokens = subTokens.slice(0, 240).map((segment, index) => {
    let hash = 2166136261;
    for (let i = 0; i < segment.length; i++) {
      hash ^= segment.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const deterministicId = (hash >>> 0) % 65536;
    return {
      index,
      text: segment,
      bytes: encoder.encode(segment).length,
      id: deterministicId,
    };
  });

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const pct = Math.min(100, Number(((subTokens.length / contextLimit) * 100).toFixed(2)));

  return {
    token_count: subTokens.length,
    char_count: text.length,
    byte_count: totalBytes,
    word_count: words,
    estimated_context_pct: pct,
    tokens,
  };
}

export const AI_ARCHITECTURE_SPECS: ArchitectureInterfaceSpec[] = [
  {
    id: 'genesis-core-transformer',
    name: 'Genesis Core Decoder Transformer (PyTorch)',
    layer: 'Core Model',
    implementationStatus: 'Experimental Prototype (Untrained)',
    description:
      'Modular decoder-only Transformer implemented from scratch in PyTorch (RMSNorm, CausalSelfAttention, SwiGLU FFN, weight-tied LM head) with CPU-first presets (cpu_nano, cpu_micro, cpu_small). Ships untrained — never uses downloaded weights.',
    pythonClass: 'backend/genesis_core/model.py :: GenesisCoreTransformer',
    typescriptInterface: 'src/types/genesis.ts :: GenesisCoreStatusResponse',
    methods: [
      { name: 'forward', signature: '(idx: Tensor, targets?: Tensor) -> (logits, loss)', purpose: 'Compute causal next-token logits and cross-entropy loss.' },
      { name: 'generate', signature: '(idx: Tensor, max_new_tokens, temperature, top_k) -> Tensor', purpose: 'Autoregressive sampling from trained Genesis Core checkpoints.' },
      { name: 'train', signature: '(on_progress) -> TrainingSummary', purpose: 'CPU-first gradient accumulation training loop with validation loss tracking.' },
    ],
  },
  {
    id: 'model-interface',
    name: 'Model Interface',
    layer: 'Core Model',
    implementationStatus: 'Placeholder Adapter',
    description:
      'Abstract contract decoupling model lifecycle (weight loading, checkpoint inspection, context limits) from application logic. Connects to GenesisCoreLocalInference when trained checkpoints exist.',
    pythonClass: 'backend/app/ai/interfaces.py :: BaseModelAdapter',
    typescriptInterface: 'src/ai/contracts.ts :: GenesisModelInterface',
    methods: [
      { name: 'load_weights', signature: '(local_path: str) -> tuple[bool, str]', purpose: 'Explicitly load local .pt Genesis Core checkpoints on operator request.' },
      { name: 'unload_weights', signature: '() -> None', purpose: 'Release host RAM or accelerator VRAM allocations.' },
      { name: 'get_capabilities', signature: '() -> ModelCapabilities', purpose: 'Declare context window, streaming, and tool support.' },
    ],
  },
  {
    id: 'inference-interface',
    name: 'Inference Interface',
    layer: 'Runtime',
    implementationStatus: 'Placeholder Adapter',
    description:
      'Standardized completion & chat generation contract supporting both experimental GenesisCoreLocalInference checkpoints and local OpenAI-compatible HTTP inference servers (llama.cpp / vLLM).',
    pythonClass: 'backend/genesis_core/inference.py :: GenesisCoreLocalInference',
    typescriptInterface: 'src/ai/contracts.ts :: GenesisInferenceInterface',
    methods: [
      { name: 'generate_text', signature: '(prompt: str, max_new_tokens, temperature, top_k) -> dict', purpose: 'Execute local Genesis Core checkpoint inference (refuses when untrained).' },
      { name: 'health_probe', signature: '() -> ProbeResult', purpose: 'Inspect checkpoint metadata sidecar or local HTTP server reachability.' },
    ],
  },
  {
    id: 'tokenizer-interface',
    name: 'Tokenizer & Trainable Byte-BPE Interface',
    layer: 'Core Model',
    implementationStatus: 'Deterministic Baseline Active',
    description:
      'Combines the deterministic Laboratory diagnostic tokenizer with our trainable UTF-8 GenesisByteBPETokenizer (4 special tokens + 256 lossless bytes + learned BPE merges from local corpora).',
    pythonClass: 'backend/genesis_core/tokenizer.py :: GenesisByteBPETokenizer',
    typescriptInterface: 'src/ai/contracts.ts :: GenesisTokenizerInterface',
    methods: [
      { name: 'train', signature: '(texts, target_vocab_size, min_frequency) -> dict', purpose: 'Learn deterministic BPE merges from locally sourced text files.' },
      { name: 'encode', signature: '(text: str, add_bos, add_eos) -> list[int]', purpose: 'Losslessly encode UTF-8 text into token IDs.' },
      { name: 'decode', signature: '(ids: list[int], skip_special_tokens) -> str', purpose: 'Reconstruct UTF-8 text cleanly from token identifiers.' },
    ],
  },
  {
    id: 'memory-interface',
    name: 'Memory Interface',
    layer: 'Memory',
    implementationStatus: 'Deterministic Baseline Active',
    description:
      'Structured persistent memory layer backed by local SQLite namespaces (episodic, semantic, procedural, project) with full-text search and JSON snapshot export.',
    pythonClass: 'backend/app/ai/interfaces.py :: BaseMemoryStore',
    typescriptInterface: 'src/ai/contracts.ts :: GenesisMemoryInterface',
    methods: [
      { name: 'store', signature: '(namespace: str, title: str, content: str) -> str', purpose: 'Persist memory record with importance & tags.' },
      { name: 'query', signature: '(namespace: str | None, term: str) -> list[MemoryEntry]', purpose: 'Retrieve relevant local memories without external vector APIs.' },
    ],
  },
  {
    id: 'agent-orchestrator',
    name: 'Agent Orchestration Interface',
    layer: 'Orchestration',
    implementationStatus: 'Interface Defined',
    description:
      'Step-budgeted execution planner coordinating agent state, system prompts, and sandboxed tool allowlists. Pauses cleanly at reasoning steps when no model is loaded.',
    pythonClass: 'backend/app/ai/interfaces.py :: BaseAgentOrchestrator',
    typescriptInterface: 'src/types/genesis.ts :: AgentBlueprint',
    methods: [
      { name: 'plan_steps', signature: '(goal: str, blueprint: AgentBlueprint) -> ExecutionPlan', purpose: 'Produce deterministic sandbox plan for inspection.' },
      { name: 'enforce_budget', signature: '(step: int, max_steps: int) -> bool', purpose: 'Prevent unbounded autonomous loops.' },
    ],
  },
  {
    id: 'tool-executor',
    name: 'Tool Execution Interface',
    layer: 'Orchestration',
    implementationStatus: 'Deterministic Baseline Active',
    description:
      'Allowlist-enforced sandbox boundary validating every tool invocation against operator security policies (blocking arbitrary shell/network escape by default).',
    pythonClass: 'backend/app/core/security.py :: SandboxedToolRegistry',
    typescriptInterface: 'src/ai/contracts.ts :: GenesisToolExecutorInterface',
    methods: [
      { name: 'list_allowed_tools', signature: '() -> list[str]', purpose: 'Enumerate inspected, safe local tools.' },
      { name: 'validate_execution', signature: '(tool_name: str, args: dict) -> ValidationResult', purpose: 'Verify tool permissions before dispatch.' },
    ],
  },
  {
    id: 'model-config-manager',
    name: 'Model Configuration Manager',
    layer: 'Configuration',
    implementationStatus: 'Deterministic Baseline Active',
    description:
      'Persists model manifests, local weight paths, quantization metadata, context limits, and inference endpoint URLs in the local database.',
    pythonClass: 'backend/app/ai/interfaces.py :: ModelConfigManager',
    typescriptInterface: 'src/types/genesis.ts :: ModelEntry',
    methods: [
      { name: 'register_model', signature: '(manifest: ModelCreate) -> ModelEntry', purpose: 'Register a local model manifest without downloading remote weights.' },
      { name: 'set_endpoint', signature: '(model_id: str, url: str) -> ModelEntry', purpose: 'Point Genesis to a local inference server URL.' },
    ],
  },
];
