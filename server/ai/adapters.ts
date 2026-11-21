import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type GenesisModelAdapter,
  type InferenceRequest,
  type InferenceResult,
  type InferenceStreamChunk,
  type ModelCapabilities,
  type ModelProbeResult,
  inspectTokensServer,
  isLocalInferenceUrlSafe,
} from './interfaces.ts';

export interface StoredModelRow {
  id: string;
  name: string;
  provider: string;
  model_type: string;
  local_path: string;
  endpoint_url: string;
  status: string;
  loading_status: string;
  context_length: number;
  quantization: string;
  parameter_count: string;
  metadata_json: string;
}

function combineAbortSignals(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  wasTimedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Inference request timed out after ${timeoutMs}ms`));
  }, Math.max(500, timeoutMs));

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error('Request cancelled by operator'));
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

export const DEFAULT_GENESIS_CHECKPOINT_PATH = './data/checkpoints/genesis_core/latest.pt';
export const DEFAULT_GENESIS_TOKENIZER_PATH = './data/checkpoints/genesis_core/tokenizer.json';

export interface GenesisCheckpointDiskStatus {
  checkpoint_path: string;
  meta_path: string;
  tokenizer_path: string;
  checkpoint_exists: boolean;
  metadata_exists: boolean;
  tokenizer_exists: boolean;
  experimental: true;
  trained: boolean;
  model_status: 'untrained_experimental' | 'experimental_trained';
  trained_steps: number;
  train_loss: number | null;
  val_loss: number | null;
  parameter_count: number | null;
  model_config: Record<string, unknown> | null;
  created_at: string | null;
}

export function inspectGenesisCheckpointOnDisk(
  checkpointPath = process.env.GENESIS_CORE_CHECKPOINT_PATH || DEFAULT_GENESIS_CHECKPOINT_PATH,
  tokenizerPath = process.env.GENESIS_CORE_TOKENIZER_PATH || DEFAULT_GENESIS_TOKENIZER_PATH
): GenesisCheckpointDiskStatus {
  const effectiveCkpt =
    !checkpointPath || checkpointPath === './weights/genesis-core-v0.safetensors'
      ? DEFAULT_GENESIS_CHECKPOINT_PATH
      : checkpointPath;

  const resolvedCkpt = path.resolve(process.cwd(), effectiveCkpt);
  const parsed = path.parse(resolvedCkpt);
  const resolvedMeta = path.join(parsed.dir, `${parsed.name}.meta.json`);
  const resolvedTok = path.resolve(
    process.cwd(),
    tokenizerPath || path.join(parsed.dir, 'tokenizer.json')
  );

  const checkpointExists = fs.existsSync(resolvedCkpt) && fs.statSync(resolvedCkpt).isFile();
  const metadataExists = fs.existsSync(resolvedMeta) && fs.statSync(resolvedMeta).isFile();
  const tokenizerExists = fs.existsSync(resolvedTok) && fs.statSync(resolvedTok).isFile();

  let trainedSteps = 0;
  let trainLoss: number | null = null;
  let valLoss: number | null = null;
  let parameterCount: number | null = null;
  let modelConfig: Record<string, unknown> | null = null;
  let createdAt: string | null = null;

  if (metadataExists) {
    try {
      const raw = JSON.parse(fs.readFileSync(resolvedMeta, 'utf-8')) as Record<string, unknown>;
      trainedSteps = Number(raw.trained_steps || 0);
      trainLoss = typeof raw.train_loss === 'number' ? raw.train_loss : null;
      valLoss = typeof raw.val_loss === 'number' ? raw.val_loss : null;
      parameterCount = typeof raw.parameter_count === 'number' ? raw.parameter_count : null;
      modelConfig =
        raw.model_config && typeof raw.model_config === 'object'
          ? (raw.model_config as Record<string, unknown>)
          : null;
      createdAt = typeof raw.created_at === 'string' ? raw.created_at : null;
    } catch {
      // Ignore corrupt metadata files safely
    }
  }

  const trained = checkpointExists && trainedSteps > 0;
  return {
    checkpoint_path: effectiveCkpt,
    meta_path: resolvedMeta,
    tokenizer_path: tokenizerPath || DEFAULT_GENESIS_TOKENIZER_PATH,
    checkpoint_exists: checkpointExists,
    metadata_exists: metadataExists,
    tokenizer_exists: tokenizerExists,
    experimental: true,
    trained,
    model_status: trained ? 'experimental_trained' : 'untrained_experimental',
    trained_steps: trainedSteps,
    train_loss: trainLoss,
    val_loss: valLoss,
    parameter_count: parameterCount,
    model_config: modelConfig,
    created_at: createdAt,
  };
}

export class GenesisCorePlaceholderAdapter implements GenesisModelAdapter {
  readonly modelId: string;
  readonly provider = 'genesis_core';
  private readonly weightsPath: string;
  private readonly contextLength: number;

  constructor(
    modelId = 'genesis-core-placeholder',
    weightsPath = DEFAULT_GENESIS_CHECKPOINT_PATH,
    contextLength = 128
  ) {
    this.modelId = modelId;
    this.weightsPath =
      !weightsPath || weightsPath === './weights/genesis-core-v0.safetensors'
        ? DEFAULT_GENESIS_CHECKPOINT_PATH
        : weightsPath;
    this.contextLength = contextLength;
  }

  getCapabilities(): ModelCapabilities {
    return {
      max_context_tokens: this.contextLength,
      supports_streaming: false,
      supports_tool_calling: false,
      provider: this.provider,
    };
  }

  async healthProbe(): Promise<ModelProbeResult> {
    const status = inspectGenesisCheckpointOnDisk(this.weightsPath);
    if (status.trained) {
      return {
        reachable: false,
        status_code: null,
        detected_models: [`genesis-core-experimental-${status.trained_steps}steps`],
        server_model: `genesis-core-experimental-${status.trained_steps}steps`,
        message: `Experimental Genesis Core checkpoint found at ${status.checkpoint_path} (${status.trained_steps} steps, val_loss=${status.val_loss ?? 'n/a'}). Run Python PyTorch runtime (backend/genesis_core/inference.py) to execute tensor inference.`,
        payload: status,
      };
    }

    return {
      reachable: false,
      status_code: null,
      detected_models: [],
      server_model: null,
      message: `Genesis Core is an untrained experimental prototype (PyTorch architecture ready in backend/genesis_core/). No trained checkpoint found at ${status.checkpoint_path}.`,
      payload: status,
    };
  }

  async generate(request: InferenceRequest): Promise<InferenceResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const systemMsg = request.messages.find((m) => m.role === 'system')?.content || '';
    const hasMemory = systemMsg.includes('[Approved User Memory]');
    const hasKnowledge = systemMsg.includes('[Knowledge Base Excerpts]');
    const stats = inspectTokensServer(lastUser, this.contextLength);
    const ckpt = inspectGenesisCheckpointOnDisk(this.weightsPath);

    const lines = [
      '### Demo Mode — Genesis Core (Untrained / Experimental Prototype)',
      '',
      'Your message was persisted to the local SQLite database. Because **Project Genesis** operates independently without external AI APIs and **GENESIS CORE** is currently an **untrained experimental prototype** in this Node preview runtime, this is a deterministic **Demo Mode** diagnostic envelope rather than neural generation.',
      '',
      `- **Message Tokens (Baseline)**: \`${stats.token_count}\` tokens (\`${stats.byte_count}\` UTF-8 bytes)`,
      `- **Checkpoint Slot**: \`${ckpt.checkpoint_path}\` (\`model_status=${ckpt.model_status}\`, \`trained_steps=${ckpt.trained_steps}\`)`,
      '- **Local PyTorch Training CLI**: `python backend/scripts/train_genesis_core.py --corpus ./docs --preset cpu_nano --steps 100`',
    ];

    const attachmentExtractMatch = systemMsg.match(/\[Attached Media & Document Extracts\]\n([\s\S]*?)(?=\n\[|$)/);
    if (attachmentExtractMatch && attachmentExtractMatch[1].trim()) {
      lines.push(
        '',
        '**Extracted Attachment & Media Context (Local Preprocessing):**',
        attachmentExtractMatch[1].trim().slice(0, 1200)
      );
    }

    if (hasMemory || hasKnowledge) {
      const sources: string[] = [];
      if (hasMemory) sources.push('Approved User Memory');
      if (hasKnowledge) sources.push('Knowledge Base Excerpts');
      lines.push(
        `- **Local Context Retrieved**: ${sources.join(' + ')} attached to prompt context (keyword retrieval only — not AI reasoning).`
      );
      const excerptLines = systemMsg
        .split('\n')
        .filter((l) => l.startsWith('- ('))
        .slice(0, 4);
      if (excerptLines.length > 0) {
        lines.push('', '**Retrieved Local Snippets (Raw Context Preview):**', ...excerptLines);
      }
    }

    lines.push(
      '',
      'To test live chat inference right now, start an OpenAI-compatible local model server (such as `llama.cpp` server on `http://127.0.0.1:8080`) and switch the conversation model to **Local Inference Server Adapter**.'
    );

    const content = lines.join('\n');

    return {
      ok: true,
      mode: 'demo',
      model_name: 'DEMO MODE (GENESIS CORE Untrained Experimental)',
      content,
      finish_reason: 'not_connected',
      diagnostic: true,
      usage: {
        prompt_tokens: stats.token_count,
        completion_tokens: inspectTokensServer(content, this.contextLength).token_count,
      },
    };
  }

  async *generateStream(request: InferenceRequest): AsyncGenerator<InferenceStreamChunk> {
    const res = await this.generate(request);
    yield {
      type: 'done',
      content: res.content,
      mode: res.mode,
      model_name: res.model_name,
      finish_reason: res.finish_reason,
      usage: res.usage,
      diagnostic: true,
    };
  }
}

export class LocalWeightsManifestAdapter implements GenesisModelAdapter {
  readonly modelId: string;
  readonly provider: string;
  private readonly modelName: string;
  private readonly localPath: string;
  private readonly contextLength: number;

  constructor(row: StoredModelRow) {
    this.modelId = row.id;
    this.provider = row.provider;
    this.modelName = row.name;
    this.localPath = row.local_path;
    this.contextLength = row.context_length || 8192;
  }

  getCapabilities(): ModelCapabilities {
    return {
      max_context_tokens: this.contextLength,
      supports_streaming: false,
      supports_tool_calling: false,
      provider: this.provider,
    };
  }

  async healthProbe(): Promise<ModelProbeResult> {
    return {
      reachable: false,
      status_code: null,
      detected_models: [],
      server_model: null,
      message: `Manifest "${this.modelName}" registered (weights are never auto-loaded). Configure a loopback inference server endpoint to dispatch prompts.`,
    };
  }

  async generate(request: InferenceRequest): Promise<InferenceResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const stats = inspectTokensServer(lastUser, this.contextLength);
    const content = [
      `### Demo Mode — Local Runtime Not Attached for \`${this.modelName}\``,
      '',
      `This manifest (${this.provider}) points to \`${this.localPath || 'unconfigured weights path'}\` without a local HTTP inference server endpoint. Project Genesis never auto-loads weights or falls back to external AI APIs.`,
      '',
      'Start a local server (e.g., `llama.cpp` server) serving these weights and set the loopback endpoint URL in **Model Manager**.',
    ].join('\n');

    return {
      ok: true,
      mode: 'demo',
      model_name: `DEMO MODE (${this.modelName})`,
      content,
      finish_reason: 'not_connected',
      diagnostic: true,
      usage: { prompt_tokens: stats.token_count, completion_tokens: 0 },
    };
  }

  async *generateStream(request: InferenceRequest): AsyncGenerator<InferenceStreamChunk> {
    const res = await this.generate(request);
    yield {
      type: 'done',
      content: res.content,
      mode: res.mode,
      model_name: res.model_name,
      finish_reason: res.finish_reason,
      usage: res.usage,
      diagnostic: true,
    };
  }
}

export class OpenAICompatibleLocalAdapter implements GenesisModelAdapter {
  readonly modelId: string;
  readonly provider: string;
  private readonly endpointUrl: string;
  private readonly modelLabel: string;
  private readonly requestedServerModel?: string;
  private readonly contextLength: number;

  constructor(options: {
    modelId: string;
    provider?: string;
    endpointUrl: string;
    modelLabel: string;
    serverModelName?: string;
    contextLength?: number;
  }) {
    this.modelId = options.modelId;
    this.provider = options.provider || 'local_http';
    this.endpointUrl = options.endpointUrl.replace(/\/+$/, '');
    this.modelLabel = options.modelLabel;
    this.requestedServerModel = options.serverModelName;
    this.contextLength = options.contextLength || 8192;
  }

  getCapabilities(): ModelCapabilities {
    return {
      max_context_tokens: this.contextLength,
      supports_streaming: true,
      supports_tool_calling: false,
      provider: this.provider,
    };
  }

  async healthProbe(): Promise<ModelProbeResult> {
    if (!this.endpointUrl) {
      return {
        reachable: false,
        status_code: null,
        detected_models: [],
        server_model: null,
        message: 'No local HTTP inference endpoint configured.',
      };
    }

    const check = isLocalInferenceUrlSafe(this.endpointUrl);
    if (!check.valid) {
      return {
        reachable: false,
        status_code: null,
        detected_models: [],
        server_model: null,
        message: check.reason,
      };
    }

    const detectedModels: string[] = [];
    let healthStatus: number | null = null;
    let healthOk = false;
    let healthPayload: unknown = null;

    const healthAbort = combineAbortSignals(2500);
    try {
      const res = await fetch(`${this.endpointUrl}/health`, {
        method: 'GET',
        signal: healthAbort.signal,
      });
      healthStatus = res.status;
      healthOk = res.ok;
      try {
        healthPayload = await res.json();
      } catch {
        healthPayload = null;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Connection refused';
      // Still try /v1/models only if /health didn't reject at network layer
      healthAbort.cleanup();
      // Try /v1/models fallback if /health failed unexpectedly
      try {
        const modelsAbort = combineAbortSignals(2000);
        try {
          const mRes = await fetch(`${this.endpointUrl}/v1/models`, {
            method: 'GET',
            signal: modelsAbort.signal,
          });
          if (mRes.ok) {
            const mData = (await mRes.json()) as { data?: Array<{ id?: string }> };
            for (const entry of mData?.data || []) {
              if (entry?.id) detectedModels.push(String(entry.id));
            }
            const serverModel = detectedModels[0] || null;
            return {
              reachable: true,
              status_code: mRes.status,
              detected_models: detectedModels,
              server_model: serverModel,
              message: serverModel
                ? `Connected via /v1/models (HTTP ${mRes.status}). Detected model: ${serverModel}.`
                : `Connected to local inference server via /v1/models (HTTP ${mRes.status}).`,
              payload: mData,
            };
          }
        } finally {
          modelsAbort.cleanup();
        }
      } catch {
        // Both probes unreachable
      }

      return {
        reachable: false,
        status_code: null,
        detected_models: [],
        server_model: null,
        message: `No local inference server listening at ${this.endpointUrl} (${detail}).`,
      };
    } finally {
      healthAbort.cleanup();
    }

    // Query /v1/models to discover active server model identity
    const modelsAbort = combineAbortSignals(2000);
    try {
      const mRes = await fetch(`${this.endpointUrl}/v1/models`, {
        method: 'GET',
        signal: modelsAbort.signal,
      });
      if (mRes.ok) {
        const mData = (await mRes.json()) as { data?: Array<{ id?: string }> };
        for (const entry of mData?.data || []) {
          if (entry?.id) detectedModels.push(String(entry.id));
        }
      }
    } catch {
      // Optional /v1/models discovery failure should not fail a valid /health probe
    } finally {
      modelsAbort.cleanup();
    }

    const reachable = healthOk || detectedModels.length > 0;
    const serverModel = detectedModels[0] || null;
    return {
      reachable,
      status_code: healthStatus,
      detected_models: detectedModels,
      server_model: serverModel,
      message: reachable
        ? serverModel
          ? `Connected to ${this.endpointUrl} (HTTP ${healthStatus ?? 200}). Model: ${serverModel}.`
          : `Local inference server responded with HTTP ${healthStatus ?? 200}.`
        : `Local inference server at ${this.endpointUrl} returned HTTP ${healthStatus}.`,
      payload: healthPayload,
    };
  }

  private buildRequestBody(request: InferenceRequest, stream: boolean): string {
    const body: Record<string, unknown> = {
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream,
    };
    const modelName = request.model || this.requestedServerModel;
    if (modelName) {
      body.model = modelName;
    }
    return JSON.stringify(body);
  }

  async generate(request: InferenceRequest): Promise<InferenceResult> {
    if (!this.endpointUrl) {
      return {
        ok: false,
        mode: 'demo',
        model_name: 'DEMO MODE (No Endpoint Configured)',
        content: '',
        finish_reason: 'error',
        diagnostic: true,
        error: 'No local inference endpoint URL configured for this model.',
      };
    }

    const check = isLocalInferenceUrlSafe(this.endpointUrl);
    if (!check.valid) {
      return {
        ok: false,
        mode: 'demo',
        model_name: 'DEMO MODE (Endpoint Blocked)',
        content: '',
        finish_reason: 'error',
        diagnostic: true,
        error: check.reason,
      };
    }

    const { signal, cleanup, wasTimedOut } = combineAbortSignals(request.timeout_ms, request.signal);
    try {
      const res = await fetch(`${this.endpointUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.buildRequestBody(request, false),
        signal,
      });

      if (!res.ok) {
        return {
          ok: false,
          mode: 'demo',
          model_name: `DEMO MODE (${this.modelLabel})`,
          content: '',
          finish_reason: 'error',
          diagnostic: true,
          error: `Local inference endpoint returned HTTP ${res.status}`,
        };
      }

      let data: {
        model?: string;
        choices?: Array<{
          message?: { content?: string };
          text?: string;
          finish_reason?: string;
        }>;
        response?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        return {
          ok: false,
          mode: 'demo',
          model_name: `DEMO MODE (${this.modelLabel})`,
          content: '',
          finish_reason: 'error',
          diagnostic: true,
          error: 'Local inference server returned invalid JSON payload.',
        };
      }

      const text =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text ??
        data?.response;

      if (typeof text !== 'string' || !text.length) {
        return {
          ok: false,
          mode: 'demo',
          model_name: `DEMO MODE (${this.modelLabel})`,
          content: '',
          finish_reason: 'error',
          diagnostic: true,
          error: 'Local inference response missing expected text payload.',
        };
      }

      return {
        ok: true,
        mode: 'local_inference',
        model_name: data.model
          ? `${data.model} (${this.endpointUrl})`
          : `${this.modelLabel} (${this.endpointUrl})`,
        content: text,
        finish_reason: data?.choices?.[0]?.finish_reason || 'stop',
        usage: data.usage,
        diagnostic: false,
      };
    } catch (err) {
      const abortedByCaller = request.signal?.aborted ?? false;
      const reason = wasTimedOut()
        ? `Local inference request timed out after ${request.timeout_ms} ms.`
        : abortedByCaller
          ? 'Inference cancelled by operator.'
          : err instanceof Error
            ? err.message
            : 'Failed to reach local inference server';
      return {
        ok: false,
        mode: 'demo',
        model_name: `DEMO MODE (${this.modelLabel})`,
        content: '',
        finish_reason: abortedByCaller ? 'cancelled' : 'error',
        diagnostic: true,
        error: reason,
      };
    } finally {
      cleanup();
    }
  }

  async *generateStream(request: InferenceRequest): AsyncGenerator<InferenceStreamChunk> {
    if (!this.endpointUrl) {
      yield { type: 'error', error: 'No local inference endpoint URL configured.', finish_reason: 'error' };
      return;
    }

    const check = isLocalInferenceUrlSafe(this.endpointUrl);
    if (!check.valid) {
      yield { type: 'error', error: check.reason, finish_reason: 'error' };
      return;
    }

    const { signal, cleanup, wasTimedOut } = combineAbortSignals(request.timeout_ms, request.signal);
    let accumulated = '';
    let resolvedModel = `${this.modelLabel} (${this.endpointUrl})`;
    let finishReason = 'stop';
    let usage: InferenceResult['usage'];

    try {
      const res = await fetch(`${this.endpointUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.buildRequestBody(request, true),
        signal,
      });

      if (!res.ok) {
        yield {
          type: 'error',
          error: `Local inference endpoint returned HTTP ${res.status}`,
          finish_reason: 'error',
        };
        return;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        // Server returned non-streamed JSON despite stream=true
        try {
          const data = (await res.json()) as {
            model?: string;
            choices?: Array<{ message?: { content?: string }; text?: string; finish_reason?: string }>;
            response?: string;
            usage?: InferenceResult['usage'];
          };
          const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.response;
          if (typeof text !== 'string' || !text.length) {
            yield {
              type: 'error',
              error: 'Local inference response missing expected text payload.',
              finish_reason: 'error',
            };
            return;
          }
          if (data.model) resolvedModel = `${data.model} (${this.endpointUrl})`;
          yield { type: 'delta', delta: text, content: text };
          yield {
            type: 'done',
            content: text,
            mode: 'local_inference',
            model_name: resolvedModel,
            finish_reason: data?.choices?.[0]?.finish_reason || 'stop',
            usage: data.usage,
            diagnostic: false,
          };
          return;
        } catch {
          yield {
            type: 'error',
            error: 'Local inference server returned invalid JSON payload.',
            finish_reason: 'error',
          };
          return;
        }
      }

      if (!res.body) {
        yield { type: 'error', error: 'Local inference server returned an empty response stream.', finish_reason: 'error' };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payloadStr = line.slice(5).trim();
          if (payloadStr === '[DONE]') {
            yield {
              type: 'done',
              content: accumulated,
              mode: 'local_inference',
              model_name: resolvedModel,
              finish_reason: finishReason,
              usage,
              diagnostic: false,
            };
            return;
          }

          let parsed: {
            model?: string;
            choices?: Array<{
              delta?: { content?: string };
              message?: { content?: string };
              text?: string;
              finish_reason?: string | null;
            }>;
            content?: string;
            usage?: InferenceResult['usage'];
          };
          try {
            parsed = JSON.parse(payloadStr) as typeof parsed;
          } catch {
            // Skip malformed SSE frame or surface error cleanly
            yield {
              type: 'error',
              content: accumulated,
              error: 'Local inference stream emitted malformed JSON chunk.',
              finish_reason: 'error',
            };
            return;
          }

          if (parsed.model) {
            resolvedModel = `${parsed.model} (${this.endpointUrl})`;
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta =
            choice?.delta?.content ??
            choice?.message?.content ??
            choice?.text ??
            parsed.content ??
            '';

          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta;
            yield {
              type: 'delta',
              delta,
              content: accumulated,
              mode: 'local_inference',
              model_name: resolvedModel,
            };
          }
        }
      }

      if (!accumulated) {
        yield {
          type: 'error',
          error: 'Local inference stream closed without generating any tokens.',
          finish_reason: 'error',
        };
        return;
      }

      yield {
        type: 'done',
        content: accumulated,
        mode: 'local_inference',
        model_name: resolvedModel,
        finish_reason: finishReason,
        usage,
        diagnostic: false,
      };
    } catch (err) {
      const abortedByCaller = request.signal?.aborted ?? false;
      const reason = wasTimedOut()
        ? `Local inference stream timed out after ${request.timeout_ms} ms.`
        : abortedByCaller
          ? 'Generation cancelled by operator.'
          : err instanceof Error
            ? err.message
            : 'Stream connection interrupted.';
      yield {
        type: 'error',
        content: accumulated,
        mode: accumulated ? 'local_inference' : 'demo',
        model_name: resolvedModel,
        error: reason,
        finish_reason: abortedByCaller ? 'cancelled' : 'error',
      };
    } finally {
      cleanup();
    }
  }
}

export function resolveModelAdapter(
  db: DatabaseSync,
  requestedModelId: string | null | undefined,
  defaultInferenceUrl: string
): { adapter: GenesisModelAdapter; model: StoredModelRow } | { error: string; status: number } {
  const effectiveId = requestedModelId || 'genesis-core-placeholder';
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(effectiveId) as StoredModelRow | undefined;
  if (!row) {
    return { status: 404, error: `Model "${effectiveId}" not found in model registry.` };
  }

  let parsedMeta: { server_model?: string } = {};
  try {
    parsedMeta = JSON.parse(row.metadata_json || '{}') as { server_model?: string };
  } catch {
    parsedMeta = {};
  }

  if (row.provider === 'genesis_core') {
    return {
      model: row,
      adapter: new GenesisCorePlaceholderAdapter(
        row.id,
        row.local_path || DEFAULT_GENESIS_CHECKPOINT_PATH,
        row.context_length || 128
      ),
    };
  }

  const endpoint = (row.endpoint_url || '').trim() || (row.id === 'local-inference-http' ? defaultInferenceUrl.trim() : '');
  if (row.provider === 'local_http' || endpoint) {
    return {
      model: row,
      adapter: new OpenAICompatibleLocalAdapter({
        modelId: row.id,
        provider: row.provider,
        endpointUrl: endpoint,
        modelLabel: row.name,
        serverModelName: parsedMeta.server_model,
        contextLength: row.context_length || 8192,
      }),
    };
  }

  return {
    model: row,
    adapter: new LocalWeightsManifestAdapter(row),
  };
}
