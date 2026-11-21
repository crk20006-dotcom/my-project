export interface TokenizerInspection {
  token_count: number;
  char_count: number;
  byte_count: number;
  word_count: number;
  estimated_context_pct: number;
  tokens: Array<{ index: number; text: string; bytes: number; id: number }>;
}

export interface ModelCapabilities {
  max_context_tokens: number;
  supports_streaming: boolean;
  supports_tool_calling: boolean;
  provider: string;
}

export interface InferenceUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

export interface InferenceRequest {
  messages: InferenceMessage[];
  model?: string;
  max_tokens: number;
  temperature: number;
  timeout_ms: number;
  system_prompt?: string;
  signal?: AbortSignal;
}

export interface InferenceResult {
  ok: boolean;
  mode: 'demo' | 'local_inference' | 'genesis_core';
  model_name: string;
  content: string;
  finish_reason: string;
  usage?: InferenceUsage;
  error?: string;
  diagnostic?: boolean;
}

export interface InferenceStreamChunk {
  type: 'delta' | 'done' | 'error';
  delta?: string;
  content?: string;
  mode?: 'demo' | 'local_inference' | 'genesis_core';
  model_name?: string;
  finish_reason?: string;
  usage?: InferenceUsage;
  error?: string;
  diagnostic?: boolean;
}

export interface ModelProbeResult {
  reachable: boolean;
  status_code: number | null;
  message: string;
  detected_models: string[];
  server_model?: string | null;
  payload?: unknown;
}

export interface GenesisModelAdapter {
  readonly modelId: string;
  readonly provider: string;
  getCapabilities(): ModelCapabilities;
  healthProbe(): Promise<ModelProbeResult>;
  generate(request: InferenceRequest): Promise<InferenceResult>;
  generateStream(request: InferenceRequest): AsyncGenerator<InferenceStreamChunk>;
}

export function inspectTokensServer(text: string, contextLimit = 8192): TokenizerInspection {
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

  const rawSegments = text.match(/(\s+|[A-Za-z0-9]+|[^\sA-Za-z0-9]+)/g) || [];
  const subTokens: string[] = [];
  for (const seg of rawSegments) {
    if (/^\s+$/.test(seg) || seg.length <= 5) {
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
    return {
      index,
      text: segment,
      bytes: encoder.encode(segment).length,
      id: (hash >>> 0) % 65536,
    };
  });

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    token_count: subTokens.length,
    char_count: text.length,
    byte_count: totalBytes,
    word_count: words,
    estimated_context_pct: Math.min(100, Number(((subTokens.length / contextLimit) * 100).toFixed(2))),
    tokens,
  };
}

export function buildContextMessages(
  history: Array<{ role: string; content: string }>,
  contextLength: number,
  maxOutputTokens: number,
  systemPrompt?: string
): { messages: InferenceMessage[]; estimated_prompt_tokens: number; truncated_messages: number } {
  const safeContext = Math.max(512, contextLength || 8192);
  const reservedOutput = Math.min(Math.floor(safeContext / 2), Math.max(32, maxOutputTokens || 512));
  let budget = Math.max(256, safeContext - reservedOutput);

  const result: InferenceMessage[] = [];
  let usedTokens = 0;

  if (systemPrompt && systemPrompt.trim()) {
    const sysTokens = inspectTokensServer(systemPrompt, safeContext).token_count + 4;
    if (sysTokens < budget) {
      budget -= sysTokens;
      usedTokens += sysTokens;
      result.push({ role: 'system', content: systemPrompt.trim() });
    }
  }

  const selectedReversed: InferenceMessage[] = [];
  let truncatedCount = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const msgTokens = inspectTokensServer(item.content || '', safeContext).token_count + 4;
    if (selectedReversed.length === 0 && msgTokens > budget) {
      // Always keep at least the latest message, trimmed gracefully if enormous
      const maxChars = Math.max(256, budget * 3);
      selectedReversed.push({ role: item.role, content: (item.content || '').slice(0, maxChars) });
      usedTokens += Math.min(msgTokens, budget);
      budget = 0;
      truncatedCount += i;
      break;
    }
    if (msgTokens <= budget) {
      selectedReversed.push({ role: item.role, content: item.content });
      usedTokens += msgTokens;
      budget -= msgTokens;
    } else {
      truncatedCount += i + 1;
      break;
    }
  }

  selectedReversed.reverse();
  return {
    messages: [...result, ...selectedReversed],
    estimated_prompt_tokens: usedTokens,
    truncated_messages: truncatedCount,
  };
}

export function isLocalInferenceUrlSafe(rawUrl: string): { valid: boolean; reason: string } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Only http:// or https:// local inference endpoints are permitted.' };
    }
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!allowedHosts.has(parsed.hostname)) {
      return {
        valid: false,
        reason: `Host "${parsed.hostname}" blocked by local-only security policy. Only localhost / 127.0.0.1 inference servers are permitted.`,
      };
    }
    return { valid: true, reason: 'Valid local loopback endpoint.' };
  } catch {
    return { valid: false, reason: 'Invalid URL format.' };
  }
}
