import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  clearAllSessions,
  createBinaryBackupTempFile,
  createSession,
  getDb,
  getDbPath,
  hashPasscode,
  hasFts5Support,
  resetWorkspaceData,
  restoreDatabaseSnapshot,
  revokeSessionToken,
  runDatabaseIntegrityCheck,
  runInTransaction,
  verifySessionToken,
} from '../db.ts';
import {
  buildContextMessages,
  inspectTokensServer,
  isLocalInferenceUrlSafe,
} from '../ai/interfaces.ts';
import { inspectGenesisCheckpointOnDisk, resolveModelAdapter } from '../ai/adapters.ts';
import {
  chunkKnowledgeText,
  detectSensitiveSecret,
  formatRetrievedSystemContext,
  searchConversationHistory,
  SqliteKeywordRetriever,
} from '../ai/memoryRetrieval.ts';
import { defaultAgentManager } from '../agent/agentManager.ts';
import { createCreatorStudioRouter } from '../creator/creatorRoutes.ts';
import { createEngineeringRouter } from '../engineering/engineeringRoutes.ts';
import { DEFAULT_CHAT_ALLOWED_EXTENSIONS } from '../multimodal/mediaSafety.ts';
import { createMultimodalRouter } from '../multimodal/multimodalRoutes.ts';
import {
  WORLD_INTELLIGENCE_PROVIDERS,
  checkWorldRateLimit,
  fetchPublicUrlOrFeed,
  resolveWorldSearchProvider,
} from '../research/worldIntelligence.ts';
import {
  clearBufferedLogs,
  getRecentSystemLogs,
  getSystemLogSummary,
  logSystemEvent,
} from '../system/logger.ts';

interface StoredCoreSettings {
  operator_name: string;
  local_auth_enabled: boolean;
  passcode_hash: string;
  passcode_salt: string;
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
  step10_media_defaults_applied?: boolean;
  first_run_completed?: boolean;
}

function getCoreSettings(): StoredCoreSettings {
  const defaults: StoredCoreSettings = {
    operator_name: 'Local Operator',
    local_auth_enabled: false,
    passcode_hash: '',
    passcode_salt: '',
    inference_endpoint_url: 'http://127.0.0.1:8080',
    prefer_local_inference: false,
    active_model_id: 'genesis-core-placeholder',
    chat_use_memory: true,
    chat_use_knowledge: true,
    inference_temperature: 0.2,
    inference_max_tokens: 512,
    inference_timeout_ms: 30000,
    max_upload_mb: 5,
    allowed_extensions: [...DEFAULT_CHAT_ALLOWED_EXTENSIONS],
    sandbox_strict_mode: true,
    voice_sample_rate: 16000,
    voice_vad_threshold: 0.45,
    voice_stt_adapter: 'browser_web_speech_or_whisper_http',
    voice_tts_adapter: 'browser_speech_synthesis_or_piper_http',
    voice_stt_language: 'en-US',
    voice_tts_voice: '',
    voice_tts_rate: 1.0,
    voice_auto_speak: false,
    voice_stt_endpoint_url: '',
    voice_tts_endpoint_url: '',
    vision_endpoint_url: '',
    ocr_enabled: true,
    step10_media_defaults_applied: true,
    first_run_completed: false,
  };
  const db = getDb();
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get('core_config') as
    | { value_json: string }
    | undefined;
  if (!row) {
    return defaults;
  }
  const stored = JSON.parse(row.value_json) as Partial<StoredCoreSettings>;
  const merged = { ...defaults, ...stored };
  if (!stored.step10_media_defaults_applied) {
    const extSet = new Set([
      ...(stored.allowed_extensions || []),
      ...DEFAULT_CHAT_ALLOWED_EXTENSIONS,
    ]);
    merged.allowed_extensions = Array.from(extSet);
    merged.step10_media_defaults_applied = true;
  }
  return merged;
}

function sanitizeSettingsForClient(settings: StoredCoreSettings) {
  return {
    operator_name: settings.operator_name,
    local_auth_enabled: settings.local_auth_enabled,
    has_passcode: Boolean(settings.passcode_hash),
    inference_endpoint_url: settings.inference_endpoint_url,
    prefer_local_inference: settings.prefer_local_inference,
    active_model_id: settings.active_model_id,
    chat_use_memory: settings.chat_use_memory,
    chat_use_knowledge: settings.chat_use_knowledge,
    inference_temperature: settings.inference_temperature,
    inference_max_tokens: settings.inference_max_tokens,
    inference_timeout_ms: settings.inference_timeout_ms,
    max_upload_mb: settings.max_upload_mb,
    allowed_extensions: settings.allowed_extensions,
    sandbox_strict_mode: settings.sandbox_strict_mode,
    voice_sample_rate: settings.voice_sample_rate,
    voice_vad_threshold: settings.voice_vad_threshold,
    voice_stt_adapter: settings.voice_stt_adapter,
    voice_tts_adapter: settings.voice_tts_adapter,
    voice_stt_language: settings.voice_stt_language,
    voice_tts_voice: settings.voice_tts_voice,
    voice_tts_rate: settings.voice_tts_rate,
    voice_auto_speak: settings.voice_auto_speak,
    voice_stt_endpoint_url: settings.voice_stt_endpoint_url,
    voice_tts_endpoint_url: settings.voice_tts_endpoint_url,
    vision_endpoint_url: settings.vision_endpoint_url,
    ocr_enabled: settings.ocr_enabled,
    first_run_completed: Boolean(settings.first_run_completed),
  };
}

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const SESSION_COOKIE_NAME = 'genesis_session';
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_PREVIEW_TEXT_CHARS = 4000;
const PASSCODE_WINDOW_MS = 60_000;
const PASSCODE_MAX_FAILURES = 5;

function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) return {};
  const result: Record<string, string> = {};
  for (const part of headerValue.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

function extractSessionToken(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

function isHttpsRequest(req: express.Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

function setSessionCookie(
  req: express.Request,
  res: express.Response,
  token: string,
  maxAgeSeconds = 8 * 60 * 60
): void {
  const https = isHttpsRequest(req);
  const options: express.CookieOptions & { partitioned?: boolean } = {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
  if (https) {
    options.partitioned = true;
  }
  res.cookie(SESSION_COOKIE_NAME, token, options);
}

function clearSessionCookie(req: express.Request, res: express.Response): void {
  const https = isHttpsRequest(req);
  const options: express.CookieOptions & { partitioned?: boolean } = {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    path: '/',
  };
  if (https) {
    options.partitioned = true;
  }
  res.clearCookie(SESSION_COOKIE_NAME, options);
}

const API_RATE_WINDOW_MS = 60_000;
const API_RATE_MAX_REQUESTS = 600;

export function createApiRouter(): express.Router {
  const router = express.Router();
  const failedAttempts = new Map<string, number[]>();
  const apiRequestTimestamps = new Map<string, number[]>();

  function getClientKey(req: express.Request): string {
    return req.ip || req.socket.remoteAddress || 'local';
  }

  function checkApiRateLimit(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const recent = (apiRequestTimestamps.get(key) || []).filter((ts) => now - ts < API_RATE_WINDOW_MS);
    if (recent.length >= API_RATE_MAX_REQUESTS) {
      apiRequestTimestamps.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil((API_RATE_WINDOW_MS - (now - recent[0])) / 1000));
      return { allowed: false, retryAfterSec };
    }
    recent.push(now);
    apiRequestTimestamps.set(key, recent);
    return { allowed: true, retryAfterSec: 0 };
  }

  function checkRateLimit(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const recent = (failedAttempts.get(key) || []).filter((ts) => now - ts < PASSCODE_WINDOW_MS);
    if (recent.length > 0) {
      failedAttempts.set(key, recent);
    } else {
      failedAttempts.delete(key);
    }
    if (recent.length >= PASSCODE_MAX_FAILURES) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((PASSCODE_WINDOW_MS - (now - oldest)) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  function recordFailedAttempt(key: string): void {
    const now = Date.now();
    const recent = (failedAttempts.get(key) || []).filter((ts) => now - ts < PASSCODE_WINDOW_MS);
    recent.push(now);
    failedAttempts.set(key, recent);
  }

  function clearFailedAttempts(key: string): void {
    failedAttempts.delete(key);
  }

  // Defensive security headers & global API rate limiting
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path !== '/health') {
      const rl = checkApiRateLimit(getClientKey(req));
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        res.status(429).json({
          error: `API rate limit exceeded. Try again in ${rl.retryAfterSec}s.`,
          code: 'RATE_LIMITED',
        });
        return;
      }
    }

    // Same-origin CSRF protection for state-changing requests when an Origin header is present
    const method = req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const originHeader = req.headers.origin;
      const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
      if (typeof originHeader === 'string' && typeof hostHeader === 'string') {
        try {
          const originHost = new URL(originHeader).host.toLowerCase();
          const expectedHost = String(hostHeader).split(',')[0].trim().toLowerCase();
          if (originHost !== expectedHost) {
            logSystemEvent('warn', 'security', 'Blocked cross-origin mutation attempt', {
              originHost,
              expectedHost,
              path: req.path,
            });
            res.status(403).json({
              error: 'Cross-origin request rejected by local security policy.',
              code: 'CSRF_ORIGIN_MISMATCH',
            });
            return;
          }
        } catch {
          res.status(403).json({ error: 'Malformed Origin header.', code: 'CSRF_ORIGIN_MISMATCH' });
          return;
        }
      }
    }

    next();
  });

  // Public auth status probe (never leaks settings or secrets)
  router.get('/auth/status', (req, res) => {
    const db = getDb();
    const settings = getCoreSettings();
    const token = extractSessionToken(req);
    const authenticated =
      !settings.local_auth_enabled || !settings.passcode_hash || verifySessionToken(db, token);

    res.json({
      local_auth_enabled: settings.local_auth_enabled,
      has_passcode: Boolean(settings.passcode_hash),
      operator_name: settings.operator_name,
      authenticated,
    });
  });

  router.post('/auth/logout', (req, res) => {
    const db = getDb();
    const token = extractSessionToken(req);
    revokeSessionToken(db, token);
    clearSessionCookie(req, res);
    res.json({ logged_out: true });
  });

  // Server-side authentication middleware protecting all private /api routes
  router.use((req, res, next) => {
    const openPaths = new Set(['/health', '/auth/status', '/auth/logout', '/settings/verify-passcode']);
    if (openPaths.has(req.path)) {
      next();
      return;
    }

    const settings = getCoreSettings();
    if (!settings.local_auth_enabled || !settings.passcode_hash) {
      next();
      return;
    }

    const db = getDb();
    const token = extractSessionToken(req);
    if (!verifySessionToken(db, token)) {
      res.status(401).json({
        error: 'Authentication required or session expired.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    next();
  });

  // ---------------------------------------------------------------------------
  // Health & Hardware Diagnostics
  // ---------------------------------------------------------------------------
  router.get('/health', (_req, res) => {
    const db = getDb();
    let dbConnected = false;
    try {
      db.prepare('SELECT 1').get();
      dbConnected = true;
    } catch {
      dbConnected = false;
    }

    const cpus = os.cpus();
    const totalMemGb = Number((os.totalmem() / (1024 ** 3)).toFixed(2));
    const freeMemGb = Number((os.freemem() / (1024 ** 3)).toFixed(2));
    const procMem = process.memoryUsage();
    const boundHost = process.env.HOST || '0.0.0.0';
    const lanExposed = boundHost === '0.0.0.0' || boundHost === '::';
    const logSummary = getSystemLogSummary();

    res.json({
      status: dbConnected ? 'ok' : 'degraded',
      service: 'Project Genesis Core Platform',
      stage: 'Step 12 — Security, Deployment & Product Expansion',
      runtime: `Node.js ${process.version} (Live Preview Runtime · FastAPI Parity in /backend)`,
      uptime_sec: Math.round(process.uptime()),
      database: {
        connected: dbConnected,
        engine: 'SQLite (node:sqlite)',
        path: getDbPath(),
      },
      hardware: {
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpu_model: cpus[0]?.model || 'Unknown CPU',
        cpu_cores: cpus.length,
        total_memory_gb: totalMemGb,
        free_memory_gb: freeMemGb,
        process_rss_mb: Number((procMem.rss / (1024 * 1024)).toFixed(1)),
        process_heap_mb: Number((procMem.heapUsed / (1024 * 1024)).toFixed(1)),
      },
      deployment: {
        host_binding: boundHost,
        lan_exposed: lanExposed,
        windows_16gb_ram_compatible: true,
        local_gpu_required: false,
      },
      reliability: {
        error_count: logSummary.error_count,
        warn_count: logSummary.warn_count,
        last_error_at: logSummary.last_error_at,
      },
      model_inference: {
        mode: 'demo',
        active_model: null,
        external_ai_apis_disabled: true,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Attachment Security Validation
  // ---------------------------------------------------------------------------
  router.post('/upload/validate', (req, res) => {
    const settings = getCoreSettings();
    const { name, size, mimeType, previewText } = req.body as {
      name?: string;
      size?: number;
      mimeType?: string;
      previewText?: string;
    };

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Filename is required.' });
      return;
    }

    const sanitizedName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(sanitizedName).toLowerCase();
    const allowed = settings.allowed_extensions.map((e) => e.toLowerCase());

    if (!ext || !allowed.includes(ext)) {
      res.status(400).json({
        error: `Extension "${ext || '(none)'}" is blocked by local upload policy. Allowed: ${allowed.join(', ')}`,
      });
      return;
    }

    const maxBytes = settings.max_upload_mb * 1024 * 1024;
    if (typeof size !== 'number' || size < 0 || size > maxBytes) {
      res.status(400).json({
        error: `File size exceeds maximum limit of ${settings.max_upload_mb} MB.`,
      });
      return;
    }

    res.json({
      id: `att-${crypto.randomUUID()}`,
      name: sanitizedName,
      size,
      mimeType: mimeType || 'application/octet-stream',
      extension: ext,
      previewText: typeof previewText === 'string' ? previewText.slice(0, 4000) : undefined,
      validated: true,
    });
  });

  // ---------------------------------------------------------------------------
  // Conversations & Messages (Genesis Chat)
  // ---------------------------------------------------------------------------
  router.get('/conversations', (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
         ORDER BY c.updated_at DESC`
      )
      .all();
    res.json(rows);
  });

  router.get('/conversations/search', (req, res) => {
    const db = getDb();
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Number(req.query.limit || 20);
    const matches = searchConversationHistory(db, q, Number.isFinite(limit) ? limit : 20);
    res.json({ query: q.trim(), matches });
  });

  router.post('/conversations', (req, res) => {
    const db = getDb();
    const settings = getCoreSettings();
    const { title, module, model_id } = req.body as {
      title?: string;
      module?: string;
      model_id?: string | null;
    };

    const resolvedModelId =
      model_id !== undefined
        ? model_id
        : settings.prefer_local_inference
          ? 'local-inference-http'
          : 'genesis-core-placeholder';

    if (resolvedModelId) {
      const modelRow = db.prepare('SELECT id FROM models WHERE id = ?').get(resolvedModelId);
      if (!modelRow) {
        res.status(404).json({ error: `Model "${resolvedModelId}" not found in model registry.` });
        return;
      }
    }

    const now = new Date().toISOString();
    const id = `conv-${crypto.randomUUID()}`;
    const safeTitle = (title || 'New Conversation').trim().slice(0, 120) || 'New Conversation';

    db.prepare(
      'INSERT INTO conversations (id, title, module, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, safeTitle, module || 'chat', resolvedModelId || 'genesis-core-placeholder', now, now);

    const created = db.prepare('SELECT *, 0 AS message_count FROM conversations WHERE id = ?').get(id);
    res.status(201).json(created);
  });

  router.patch('/conversations/:id', (req, res) => {
    const db = getDb();
    const { title, model_id } = req.body as { title?: string; model_id?: string | null };

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as
      | { id: string; title: string; model_id: string | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    if (title === undefined && model_id === undefined) {
      res.status(400).json({ error: 'Title or model_id update is required.' });
      return;
    }

    let nextTitle = existing.title;
    if (title !== undefined) {
      const safeTitle = title.trim().slice(0, 120);
      if (!safeTitle) {
        res.status(400).json({ error: 'Title cannot be empty.' });
        return;
      }
      nextTitle = safeTitle;
    }

    let nextModelId = existing.model_id;
    if (model_id !== undefined) {
      if (model_id) {
        const modelExists = db.prepare('SELECT id FROM models WHERE id = ?').get(model_id);
        if (!modelExists) {
          res.status(404).json({ error: `Model "${model_id}" not found in model registry.` });
          return;
        }
      }
      nextModelId = model_id;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE conversations SET title = ?, model_id = ?, updated_at = ? WHERE id = ?').run(
      nextTitle,
      nextModelId,
      now,
      req.params.id
    );

    const updated = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.id = ?`
      )
      .get(req.params.id);
    res.json(updated);
  });

  router.delete('/conversations/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  router.get('/conversations/:id/messages', (req, res) => {
    const db = getDb();
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const rows = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(req.params.id) as Array<{
      id: string;
      conversation_id: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      attachments_json: string;
      metadata_json: string;
      created_at: string;
    }>;

    res.json(
      rows.map((r) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        role: r.role,
        content: r.content,
        attachments: parseJsonSafe(r.attachments_json, []),
        metadata: parseJsonSafe(r.metadata_json, { mode: 'demo' }),
        created_at: r.created_at,
      }))
    );
  });

  const prepareConversationTurn = (
    req: express.Request
  ):
    | {
        ok: false;
        status: number;
        error: string;
      }
    | {
        ok: true;
        conv: { id: string; title: string; model_id: string | null };
        trimmed: string;
        safeAttachments: Array<{
          id: string;
          name: string;
          size: number;
          mimeType: string;
          extension: string;
          previewText?: string;
          imageDataUrl?: string;
          mediaKind?: 'image' | 'document' | 'audio' | 'text';
          validated: boolean;
        }>;
        settings: StoredCoreSettings;
        adapterResolution: Exclude<ReturnType<typeof resolveModelAdapter>, { error: string; status: number }>;
        temperature: number;
        maxTokens: number;
        timeoutMs: number;
        useMemory: boolean;
        useKnowledge: boolean;
        userMessage: {
          id: string;
          conversation_id: string;
          role: 'user';
          content: string;
          attachments: Array<{
            id: string;
            name: string;
            size: number;
            mimeType: string;
            extension: string;
            previewText?: string;
            imageDataUrl?: string;
            mediaKind?: 'image' | 'document' | 'audio' | 'text';
            validated: boolean;
          }>;
          metadata: { mode: 'demo'; token_count: number };
          created_at: string;
        };
      } => {
    const db = getDb();
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as
      | { id: string; title: string; model_id: string | null }
      | undefined;

    if (!conv) {
      return { ok: false, status: 404, error: 'Conversation not found.' };
    }

    const { content, attachments, model_id, temperature, max_tokens, timeout_ms, use_memory, use_knowledge } =
      req.body as {
        content?: string;
        attachments?: Array<{
          id: string;
          name: string;
          size: number;
          mimeType: string;
          extension: string;
          previewText?: string;
          imageDataUrl?: string;
          mediaKind?: 'image' | 'document' | 'audio' | 'text';
          validated: boolean;
        }>;
        model_id?: string | null;
        temperature?: number;
        max_tokens?: number;
        timeout_ms?: number;
        use_memory?: boolean;
        use_knowledge?: boolean;
      };

    const trimmed = (content || '').trim();
    if (!trimmed && (!attachments || attachments.length === 0)) {
      return { ok: false, status: 400, error: 'Message content or attachment is required.' };
    }

    const settings = getCoreSettings();
    const rawAttachments = Array.isArray(attachments) ? attachments : [];
    if (rawAttachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return {
        ok: false,
        status: 400,
        error: `Too many attachments. Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
      };
    }

    const safeAttachments: Array<{
      id: string;
      name: string;
      size: number;
      mimeType: string;
      extension: string;
      previewText?: string;
      imageDataUrl?: string;
      mediaKind?: 'image' | 'document' | 'audio' | 'text';
      validated: boolean;
    }> = [];
    for (const att of rawAttachments) {
      const sanitizedName = path.basename(String(att.name || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = path.extname(sanitizedName).toLowerCase();
      if (!ext || !settings.allowed_extensions.map((e) => e.toLowerCase()).includes(ext)) {
        return {
          ok: false,
          status: 400,
          error: `Attachment "${sanitizedName || '(unnamed)'}" uses disallowed extension "${ext}".`,
        };
      }
      if (typeof att.size !== 'number' || att.size < 0 || att.size > settings.max_upload_mb * 1024 * 1024) {
        return {
          ok: false,
          status: 400,
          error: `Attachment "${sanitizedName}" exceeds ${settings.max_upload_mb} MB limit.`,
        };
      }
      if (att.previewText !== undefined) {
        if (typeof att.previewText !== 'string') {
          return {
            ok: false,
            status: 400,
            error: `Attachment "${sanitizedName}" previewText must be a string.`,
          };
        }
        if (att.previewText.length > MAX_PREVIEW_TEXT_CHARS) {
          return {
            ok: false,
            status: 400,
            error: `Attachment "${sanitizedName}" previewText exceeds ${MAX_PREVIEW_TEXT_CHARS} character limit.`,
          };
        }
      }
      let safeImageDataUrl: string | undefined;
      if (
        typeof att.imageDataUrl === 'string' &&
        att.imageDataUrl.length <= 2_500_000 &&
        /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(att.imageDataUrl)
      ) {
        safeImageDataUrl = att.imageDataUrl;
      }
      const allowedKinds = new Set(['image', 'document', 'audio', 'text']);
      const safeMediaKind =
        att.mediaKind && allowedKinds.has(att.mediaKind) ? att.mediaKind : undefined;

      safeAttachments.push({
        id: String(att.id || `att-${crypto.randomUUID()}`),
        name: sanitizedName,
        size: att.size,
        mimeType: String(att.mimeType || 'application/octet-stream'),
        extension: ext,
        previewText: att.previewText,
        imageDataUrl: safeImageDataUrl,
        mediaKind: safeMediaKind,
        validated: true,
      });
    }

    const effectiveModelId =
      model_id !== undefined
        ? model_id
        : conv.model_id ?? (settings.prefer_local_inference ? 'local-inference-http' : 'genesis-core-placeholder');

    const resolved = resolveModelAdapter(db, effectiveModelId, settings.inference_endpoint_url);
    if ('error' in resolved) {
      return { ok: false, status: resolved.status, error: resolved.error };
    }

    const safeTemperature = Math.min(2, Math.max(0, Number(temperature ?? settings.inference_temperature ?? 0.2)));
    const safeMaxTokens = Math.min(8192, Math.max(32, Math.round(Number(max_tokens ?? settings.inference_max_tokens ?? 512))));
    const safeTimeoutMs = Math.min(120000, Math.max(1000, Math.round(Number(timeout_ms ?? settings.inference_timeout_ms ?? 30000))));

    const userMsgId = `msg-${crypto.randomUUID()}`;
    const userCreatedAt = new Date().toISOString();
    const tokenStats = inspectTokensServer(trimmed);

    runInTransaction(db, () => {
      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        userMsgId,
        conv.id,
        'user',
        trimmed,
        JSON.stringify(safeAttachments),
        JSON.stringify({ mode: 'demo', token_count: tokenStats.token_count }),
        userCreatedAt
      );

      if (conv.title === 'New Conversation' && trimmed) {
        const autoTitle = trimmed.slice(0, 56) + (trimmed.length > 56 ? '...' : '');
        db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
          autoTitle,
          userCreatedAt,
          conv.id
        );
      } else if (conv.title === 'New Conversation' && safeAttachments.length > 0) {
        const autoTitle = `Media: ${safeAttachments[0].name}`.slice(0, 56);
        db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
          autoTitle,
          userCreatedAt,
          conv.id
        );
      } else {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(userCreatedAt, conv.id);
      }
    });

    return {
      ok: true,
      conv,
      trimmed,
      safeAttachments,
      settings,
      adapterResolution: resolved,
      temperature: safeTemperature,
      maxTokens: safeMaxTokens,
      timeoutMs: safeTimeoutMs,
      useMemory: use_memory !== false,
      useKnowledge: use_knowledge !== false,
      userMessage: {
        id: userMsgId,
        conversation_id: conv.id,
        role: 'user',
        content: trimmed,
        attachments: safeAttachments,
        metadata: { mode: 'demo', token_count: tokenStats.token_count },
        created_at: userCreatedAt,
      },
    };
  };

  const loadPackedHistory = (
    conversationId: string,
    contextLength: number,
    maxTokens: number,
    queryText: string,
    useMemory: boolean,
    useKnowledge: boolean,
    currentAttachments: Array<{
      name: string;
      previewText?: string;
      mediaKind?: string;
    }> = []
  ) => {
    const db = getDb();
    const attachmentTexts = currentAttachments
      .filter((a) => typeof a.previewText === 'string' && a.previewText.trim().length > 0)
      .map((a) => `### Attachment: ${a.name} (${a.mediaKind || 'file'})\n${a.previewText!.trim()}`);

    const retrievalQuery = [queryText, ...currentAttachments.map((a) => a.previewText?.slice(0, 400) || '')]
      .filter(Boolean)
      .join(' ')
      .trim();

    const retriever = new SqliteKeywordRetriever(db);
    const retrieval = retriever.retrieve(retrievalQuery, {
      includeMemory: useMemory,
      includeKnowledge: useKnowledge,
      maxMemoryItems: 3,
      maxKnowledgeChunks: 3,
      contextLength,
    });

    const baseSystemContext = formatRetrievedSystemContext(retrieval);
    const mediaSystemSection =
      attachmentTexts.length > 0
        ? `[Attached Media & Document Extracts]\n${attachmentTexts.join('\n\n').slice(0, 4800)}`
        : '';
    const combinedSystemContext = [baseSystemContext, mediaSystemSection].filter(Boolean).join('\n\n');

    const recentDesc = db
      .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(conversationId) as Array<{ role: string; content: string }>;
    recentDesc.reverse();
    const packed = buildContextMessages(recentDesc, contextLength, maxTokens, combinedSystemContext);
    return {
      ...packed,
      retrievalSummary: {
        queried: retrieval.queried,
        retrieval_backend: retrieval.retrieval_backend,
        memories_used: retrieval.memories.map((m) => ({
          id: m.id,
          title: m.title,
          category: m.category,
        })),
        knowledge_used: retrieval.knowledge.map((k) => ({
          document_id: k.document_id,
          document_title: k.document_title,
          chunk_index: k.chunk_index,
        })),
        total_context_tokens: retrieval.total_context_tokens,
      },
    };
  };

  const formatInferenceFailureFallback = (
    errorDetail: string,
    endpointUrl: string,
    userTokens: number,
    userBytes: number,
    attachmentCount: number,
    partialContent = ''
  ) => {
    const lines = [];
    if (partialContent.trim()) {
      lines.push(partialContent.trim(), '', '---', '');
    }
    lines.push(
      '### Demo Mode Fallback — Local Inference Endpoint Error',
      '',
      `Attempted dispatch to \`${endpointUrl || 'local adapter'}\` did not complete: **${errorDetail}**`,
      '',
      'Project Genesis does **not** fall back to external AI APIs or fabricate model completions.',
      '',
      '```json',
      JSON.stringify(
        {
          status: 'demo_mode',
          error: errorDetail,
          user_tokens_estimated: userTokens,
          user_bytes: userBytes,
          attachments_validated: attachmentCount,
          inference_endpoint: endpointUrl,
        },
        null,
        2
      ),
      '```'
    );
    return lines.join('\n');
  };

  router.post('/conversations/:id/messages', async (req, res) => {
    const db = getDb();
    const prepared = prepareConversationTurn(req);
    if (!prepared.ok) {
      res.status(prepared.status).json({ error: prepared.error });
      return;
    }

    const {
      conv,
      trimmed,
      safeAttachments,
      adapterResolution,
      temperature,
      maxTokens,
      timeoutMs,
      useMemory,
      useKnowledge,
      userMessage,
    } = prepared;
    const { adapter, model } = adapterResolution;
    const packed = loadPackedHistory(
      conv.id,
      model.context_length || 8192,
      maxTokens,
      trimmed,
      useMemory,
      useKnowledge,
      safeAttachments
    );

    const tokenStats = inspectTokensServer(trimmed);
    const result = await adapter.generate({
      messages: packed.messages,
      max_tokens: maxTokens,
      temperature,
      timeout_ms: timeoutMs,
    });

    const endpointForNote =
      model.endpoint_url || prepared.settings.inference_endpoint_url || 'local-inference';
    const assistantContent = result.ok
      ? result.content
      : formatInferenceFailureFallback(
          result.error || 'Local inference failed',
          endpointForNote,
          tokenStats.token_count,
          tokenStats.byte_count,
          safeAttachments.length
        );
    const responseMode = result.ok ? result.mode : 'demo';
    const modelLabel = result.model_name;

    const assistantMsgId = `msg-${crypto.randomUUID()}`;
    const assistantCreatedAt = new Date(Date.now() + 5).toISOString();
    const assistantTokens = inspectTokensServer(assistantContent);
    const assistantMeta = {
      mode: responseMode,
      model_id: model.id,
      model_name: modelLabel,
      token_count: assistantTokens.token_count,
      prompt_tokens: result.usage?.prompt_tokens ?? packed.estimated_prompt_tokens,
      completion_tokens: result.usage?.completion_tokens,
      finish_reason: result.finish_reason,
      truncated_messages: packed.truncated_messages,
      diagnostic: !result.ok || Boolean(result.diagnostic),
      memory_retrieval: packed.retrievalSummary,
    };

    runInTransaction(db, () => {
      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        assistantMsgId,
        conv.id,
        'assistant',
        assistantContent,
        '[]',
        JSON.stringify(assistantMeta),
        assistantCreatedAt
      );
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantCreatedAt, conv.id);
    });

    res.status(201).json({
      user_message: userMessage,
      assistant_message: {
        id: assistantMsgId,
        conversation_id: conv.id,
        role: 'assistant',
        content: assistantContent,
        attachments: [],
        metadata: assistantMeta,
        created_at: assistantCreatedAt,
      },
    });
  });

  router.post('/conversations/:id/messages/stream', async (req, res) => {
    const db = getDb();
    const prepared = prepareConversationTurn(req);
    if (!prepared.ok) {
      res.status(prepared.status).json({ error: prepared.error });
      return;
    }

    const {
      conv,
      trimmed,
      safeAttachments,
      adapterResolution,
      temperature,
      maxTokens,
      timeoutMs,
      useMemory,
      useKnowledge,
      userMessage,
    } = prepared;
    const { adapter, model } = adapterResolution;
    const packed = loadPackedHistory(
      conv.id,
      model.context_length || 8192,
      maxTokens,
      trimmed,
      useMemory,
      useKnowledge,
      safeAttachments
    );
    const tokenStats = inspectTokensServer(trimmed);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const writeEvent = (eventName: string, payload: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const abortController = new AbortController();
    let streamFinished = false;
    res.on('close', () => {
      if (!streamFinished) {
        abortController.abort(new Error('Client disconnected or cancelled generation'));
      }
    });

    writeEvent('start', {
      user_message: userMessage,
      model_id: model.id,
      capabilities: adapter.getCapabilities(),
      context_tokens_estimated: packed.estimated_prompt_tokens,
      truncated_messages: packed.truncated_messages,
      memory_retrieval: packed.retrievalSummary,
    });

    let accumulated = '';
    let finalMode: 'demo' | 'local_inference' | 'genesis_core' = 'demo';
    let finalModelName = model.name;
    let finalFinishReason = 'stop';
    let finalUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let isDiagnostic = false;
    let streamErrorMessage: string | null = null;

    try {
      for await (const chunk of adapter.generateStream({
        messages: packed.messages,
        max_tokens: maxTokens,
        temperature,
        timeout_ms: timeoutMs,
        signal: abortController.signal,
      })) {
        if (chunk.type === 'delta' && chunk.delta) {
          accumulated += chunk.delta;
          if (chunk.mode) finalMode = chunk.mode;
          if (chunk.model_name) finalModelName = chunk.model_name;
          writeEvent('delta', {
            delta: chunk.delta,
            accumulated_length: accumulated.length,
            model_name: finalModelName,
          });
        } else if (chunk.type === 'done') {
          if (chunk.content !== undefined && (!accumulated || chunk.content.length >= accumulated.length)) {
            accumulated = chunk.content;
          }
          finalMode = chunk.mode || finalMode;
          finalModelName = chunk.model_name || finalModelName;
          finalFinishReason = chunk.finish_reason || 'stop';
          finalUsage = chunk.usage;
          isDiagnostic = Boolean(chunk.diagnostic);
        } else if (chunk.type === 'error') {
          streamErrorMessage = chunk.error || 'Inference stream interrupted.';
          finalFinishReason = chunk.finish_reason || (abortController.signal.aborted ? 'cancelled' : 'error');
          if (chunk.model_name) finalModelName = chunk.model_name;
          break;
        }
      }
    } catch (err) {
      streamErrorMessage = err instanceof Error ? err.message : 'Inference stream interrupted.';
      finalFinishReason = abortController.signal.aborted ? 'cancelled' : 'error';
    }

    const endpointForNote =
      model.endpoint_url || prepared.settings.inference_endpoint_url || 'local-inference';
    let persistedContent = accumulated;
    let persistedMode = finalMode;
    let partial = false;

    if (abortController.signal.aborted || finalFinishReason === 'cancelled') {
      finalFinishReason = 'cancelled';
      if (accumulated.trim()) {
        persistedContent = accumulated;
        persistedMode = finalMode;
        partial = true;
      } else {
        persistedContent =
          '### Generation Cancelled\n\nInference was cancelled by the operator before any tokens were emitted.';
        persistedMode = 'demo';
        isDiagnostic = true;
      }
    } else if (streamErrorMessage) {
      if (accumulated.trim()) {
        partial = true;
        persistedContent = `${accumulated}\n\n---\n\n> **Stream Interrupted**: ${streamErrorMessage}`;
        persistedMode = finalMode;
      } else {
        persistedContent = formatInferenceFailureFallback(
          streamErrorMessage,
          endpointForNote,
          tokenStats.token_count,
          tokenStats.byte_count,
          safeAttachments.length
        );
        persistedMode = 'demo';
        isDiagnostic = true;
      }
    }

    const assistantMsgId = `msg-${crypto.randomUUID()}`;
    const assistantCreatedAt = new Date(Date.now() + 5).toISOString();
    const assistantTokens = inspectTokensServer(persistedContent);
    const assistantMeta = {
      mode: persistedMode,
      model_id: model.id,
      model_name: finalModelName,
      token_count: assistantTokens.token_count,
      prompt_tokens: finalUsage?.prompt_tokens ?? packed.estimated_prompt_tokens,
      completion_tokens: finalUsage?.completion_tokens,
      finish_reason: finalFinishReason,
      truncated_messages: packed.truncated_messages,
      partial,
      diagnostic: isDiagnostic,
      memory_retrieval: packed.retrievalSummary,
    };

    runInTransaction(db, () => {
      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        assistantMsgId,
        conv.id,
        'assistant',
        persistedContent,
        '[]',
        JSON.stringify(assistantMeta),
        assistantCreatedAt
      );
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(assistantCreatedAt, conv.id);
    });

    const assistantMessage = {
      id: assistantMsgId,
      conversation_id: conv.id,
      role: 'assistant',
      content: persistedContent,
      attachments: [],
      metadata: assistantMeta,
      created_at: assistantCreatedAt,
    };

    streamFinished = true;
    if (streamErrorMessage && !abortController.signal.aborted) {
      writeEvent('error', { error: streamErrorMessage, assistant_message: assistantMessage });
    } else {
      writeEvent('done', { assistant_message: assistantMessage });
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Genesis Memory & Knowledge System (Strictly Separated Stores)
  // ---------------------------------------------------------------------------
  router.get('/memory/status', (_req, res) => {
    const db = getDb();
    const totalMemories = (
      db.prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE approved = 1').get() as { c: number }
    ).c;
    const totalKnowledgeDocs = (
      db.prepare('SELECT COUNT(*) AS c FROM knowledge_documents').get() as { c: number }
    ).c;
    const totalKnowledgeChunks = (
      db.prepare('SELECT COUNT(*) AS c FROM knowledge_chunks').get() as { c: number }
    ).c;
    const totalConversations = (
      db.prepare('SELECT COUNT(*) AS c FROM conversations').get() as { c: number }
    ).c;
    const totalMessages = (
      db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    ).c;
    res.json({
      total_memories: totalMemories,
      total_knowledge_docs: totalKnowledgeDocs,
      total_knowledge_chunks: totalKnowledgeChunks,
      total_conversations: totalConversations,
      total_messages: totalMessages,
      fts5_enabled: hasFts5Support(db),
      auto_save_disabled: true,
    });
  });

  router.get('/memory', (req, res) => {
    const db = getDb();
    const namespace = typeof req.query.namespace === 'string' ? req.query.namespace : '';
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    let rows = db.prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC').all() as Array<{
      id: string;
      namespace: string;
      category: string;
      title: string;
      content: string;
      tags_json: string;
      importance: number;
      approved: number;
      source_conversation_id: string | null;
      created_at: string;
      updated_at: string;
    }>;

    if (namespace && namespace !== 'all') {
      rows = rows.filter((r) => r.namespace === namespace);
    }
    if (category && category !== 'all') {
      rows = rows.filter((r) => (r.category || 'fact') === category);
    }
    if (q) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q) ||
          r.tags_json.toLowerCase().includes(q)
      );
    }

    res.json(
      rows.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        category: r.category || 'fact',
        title: r.title,
        content: r.content,
        tags: parseJsonSafe<string[]>(r.tags_json, []),
        importance: r.importance,
        approved: Boolean(r.approved ?? 1),
        source_conversation_id: r.source_conversation_id ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    );
  });

  router.post('/memory', (req, res) => {
    const db = getDb();
    const { namespace, category, title, content, tags, importance, approved, source_conversation_id } =
      req.body as {
        namespace?: string;
        category?: string;
        title?: string;
        content?: string;
        tags?: string[];
        importance?: number;
        approved?: boolean;
        source_conversation_id?: string | null;
      };

    if (approved === false) {
      res.status(400).json({ error: 'Explicit user approval is required before storing personal memory.' });
      return;
    }
    if (!title?.trim() || !content?.trim()) {
      res.status(400).json({ error: 'Title and content are required.' });
      return;
    }
    if (title.trim().length > 160 || content.trim().length > 4000) {
      res.status(400).json({ error: 'Memory title (max 160) or content (max 4000 chars) exceeds limit.' });
      return;
    }

    const secretFound = detectSensitiveSecret(`${title}\n${content}`);
    if (secretFound) {
      res.status(400).json({
        error: `Rejected for privacy: detected potential ${secretFound}. Never store passwords, private keys, or API tokens in memory.`,
      });
      return;
    }

    const validCategories = new Set(['fact', 'preference', 'instruction', 'constraint']);
    const safeCategory = category && validCategories.has(category) ? category : 'fact';
    const safeNamespace = namespace || 'semantic';
    const safeTitle = title.trim();
    const safeContent = content.trim();
    const safeTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    const safeTagsJson = JSON.stringify(safeTags);
    const safeImportance = Math.min(5, Math.max(1, Number(importance || 3)));
    const now = new Date().toISOString();
    const id = `mem-${crypto.randomUUID()}`;
    const fts = hasFts5Support(db);

    runInTransaction(db, () => {
      db.prepare(
        `INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, source_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(
        id,
        safeNamespace,
        safeCategory,
        safeTitle,
        safeContent,
        safeTagsJson,
        safeImportance,
        source_conversation_id || null,
        now,
        now
      );
      if (fts) {
        db.prepare(
          'INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)'
        ).run(id, safeTitle, safeContent, safeTags.join(' '));
      }
    });

    res.status(201).json({
      id,
      namespace: safeNamespace,
      category: safeCategory,
      title: safeTitle,
      content: safeContent,
      tags: safeTags,
      importance: safeImportance,
      approved: true,
      source_conversation_id: source_conversation_id || null,
      created_at: now,
      updated_at: now,
    });
  });

  router.put('/memory/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          namespace: string;
          category: string;
          title: string;
          content: string;
          tags_json: string;
          importance: number;
          approved: number;
          source_conversation_id: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Memory entry not found.' });
      return;
    }

    const { namespace, category, title, content, tags, importance } = req.body as {
      namespace?: string;
      category?: string;
      title?: string;
      content?: string;
      tags?: string[];
      importance?: number;
    };

    const nextTitle = (title !== undefined ? title : existing.title).trim();
    const nextContent = (content !== undefined ? content : existing.content).trim();
    if (!nextTitle || !nextContent) {
      res.status(400).json({ error: 'Title and content cannot be empty.' });
      return;
    }
    if (nextTitle.length > 160 || nextContent.length > 4000) {
      res.status(400).json({ error: 'Memory title (max 160) or content (max 4000 chars) exceeds limit.' });
      return;
    }
    const secretFound = detectSensitiveSecret(`${nextTitle}\n${nextContent}`);
    if (secretFound) {
      res.status(400).json({
        error: `Rejected for privacy: detected potential ${secretFound}. Never store passwords, private keys, or API tokens in memory.`,
      });
      return;
    }

    const validCategories = new Set(['fact', 'preference', 'instruction', 'constraint']);
    const nextCategory =
      category && validCategories.has(category) ? category : existing.category || 'fact';
    const nextNamespace = namespace || existing.namespace;
    const existingTags = parseJsonSafe<string[]>(existing.tags_json, []);
    const nextTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : existingTags;
    const nextTagsJson = JSON.stringify(nextTags);
    const nextImportance = Math.min(
      5,
      Math.max(1, Number(importance !== undefined ? importance : existing.importance))
    );
    const now = new Date().toISOString();
    const fts = hasFts5Support(db);

    runInTransaction(db, () => {
      db.prepare(
        `UPDATE memory_entries
         SET namespace = ?, category = ?, title = ?, content = ?, tags_json = ?, importance = ?, updated_at = ?
         WHERE id = ?`
      ).run(nextNamespace, nextCategory, nextTitle, nextContent, nextTagsJson, nextImportance, now, existing.id);

      if (fts) {
        db.prepare('DELETE FROM memory_entries_fts WHERE memory_id = ?').run(existing.id);
        db.prepare(
          'INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)'
        ).run(existing.id, nextTitle, nextContent, nextTags.join(' '));
      }
    });

    res.json({
      id: existing.id,
      namespace: nextNamespace,
      category: nextCategory,
      title: nextTitle,
      content: nextContent,
      tags: nextTags,
      importance: nextImportance,
      approved: Boolean(existing.approved ?? 1),
      source_conversation_id: existing.source_conversation_id ?? null,
      created_at: existing.created_at,
      updated_at: now,
    });
  });

  router.delete('/memory/:id', (req, res) => {
    const db = getDb();
    const fts = hasFts5Support(db);
    let changes = 0;
    runInTransaction(db, () => {
      const result = db.prepare('DELETE FROM memory_entries WHERE id = ?').run(req.params.id);
      changes = Number(result.changes);
      if (fts) {
        db.prepare('DELETE FROM memory_entries_fts WHERE memory_id = ?').run(req.params.id);
      }
    });
    if (changes === 0) {
      res.status(404).json({ error: 'Memory entry not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // Knowledge Base Documents & Chunks
  // ---------------------------------------------------------------------------
  router.get('/knowledge', (req, res) => {
    const db = getDb();
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const sourceType = typeof req.query.source_type === 'string' ? req.query.source_type : '';

    let rows = db.prepare('SELECT * FROM knowledge_documents ORDER BY updated_at DESC').all() as Array<{
      id: string;
      title: string;
      source_type: string;
      source_name: string;
      content: string;
      tags_json: string;
      chunk_count: number;
      created_at: string;
      updated_at: string;
    }>;

    if (sourceType && sourceType !== 'all') {
      rows = rows.filter((r) => r.source_type === sourceType);
    }
    if (q) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q) ||
          r.tags_json.toLowerCase().includes(q)
      );
    }

    res.json(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        source_type: r.source_type,
        source_name: r.source_name,
        content: r.content,
        tags: parseJsonSafe<string[]>(r.tags_json, []),
        chunk_count: r.chunk_count,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    );
  });

  router.get('/knowledge/:id', (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          title: string;
          source_type: string;
          source_name: string;
          content: string;
          tags_json: string;
          chunk_count: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!doc) {
      res.status(404).json({ error: 'Knowledge document not found.' });
      return;
    }
    const chunks = db
      .prepare('SELECT id, document_id, chunk_index, content, token_estimate, created_at FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC')
      .all(doc.id);
    res.json({
      id: doc.id,
      title: doc.title,
      source_type: doc.source_type,
      source_name: doc.source_name,
      content: doc.content,
      tags: parseJsonSafe<string[]>(doc.tags_json, []),
      chunk_count: doc.chunk_count,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      chunks,
    });
  });

  router.post('/knowledge', (req, res) => {
    const db = getDb();
    const { title, source_type, source_name, content, tags } = req.body as {
      title?: string;
      source_type?: string;
      source_name?: string;
      content?: string;
      tags?: string[];
    };
    if (!title?.trim() || !content?.trim()) {
      res.status(400).json({ error: 'Document title and content are required.' });
      return;
    }
    if (title.trim().length > 200 || content.length > 100000) {
      res.status(400).json({ error: 'Knowledge document exceeds maximum size (100,000 chars).' });
      return;
    }
    const secretFound = detectSensitiveSecret(`${title}\n${content}`);
    if (secretFound) {
      res.status(400).json({
        error: `Rejected for privacy: detected potential ${secretFound}. Remove credentials before indexing documents.`,
      });
      return;
    }

    const safeTitle = title.trim();
    const safeContent = content.trim();
    const safeSourceType = (source_type || 'note').trim() || 'note';
    const safeSourceName = (source_name || '').trim();
    const safeTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    const safeTagsJson = JSON.stringify(safeTags);
    const chunks = chunkKnowledgeText(safeContent);
    const docId = `kdoc-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const fts = hasFts5Support(db);

    runInTransaction(db, () => {
      db.prepare(
        `INSERT INTO knowledge_documents (id, title, source_type, source_name, content, tags_json, char_count, chunk_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        docId,
        safeTitle,
        safeSourceType,
        safeSourceName,
        safeContent,
        safeTagsJson,
        safeContent.length,
        chunks.length,
        now,
        now
      );

      for (const ch of chunks) {
        const chunkId = `kchk-${crypto.randomUUID()}`;
        db.prepare(
          `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_estimate, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(chunkId, docId, ch.chunk_index, ch.content, ch.token_estimate, now);
        if (fts) {
          db.prepare(
            'INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)'
          ).run(chunkId, docId, safeTitle, ch.content, safeTags.join(' '));
        }
      }
    });

    res.status(201).json({
      id: docId,
      title: safeTitle,
      source_type: safeSourceType,
      source_name: safeSourceName,
      content: safeContent,
      tags: safeTags,
      chunk_count: chunks.length,
      created_at: now,
      updated_at: now,
    });
  });

  router.put('/knowledge/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          title: string;
          source_type: string;
          source_name: string;
          content: string;
          tags_json: string;
          chunk_count: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Knowledge document not found.' });
      return;
    }

    const { title, source_type, source_name, content, tags } = req.body as {
      title?: string;
      source_type?: string;
      source_name?: string;
      content?: string;
      tags?: string[];
    };

    const nextTitle = (title !== undefined ? title : existing.title).trim();
    const nextContent = (content !== undefined ? content : existing.content).trim();
    if (!nextTitle || !nextContent) {
      res.status(400).json({ error: 'Document title and content cannot be empty.' });
      return;
    }
    if (nextTitle.length > 200 || nextContent.length > 100000) {
      res.status(400).json({ error: 'Knowledge document exceeds maximum size (100,000 chars).' });
      return;
    }
    const secretFound = detectSensitiveSecret(`${nextTitle}\n${nextContent}`);
    if (secretFound) {
      res.status(400).json({
        error: `Rejected for privacy: detected potential ${secretFound}. Remove credentials before indexing documents.`,
      });
      return;
    }

    const nextSourceType = (source_type !== undefined ? source_type : existing.source_type) || 'note';
    const nextSourceName = source_name !== undefined ? source_name.trim() : existing.source_name;
    const existingTags = parseJsonSafe<string[]>(existing.tags_json, []);
    const nextTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : existingTags;
    const nextTagsJson = JSON.stringify(nextTags);
    const chunks = chunkKnowledgeText(nextContent);
    const now = new Date().toISOString();
    const fts = hasFts5Support(db);

    runInTransaction(db, () => {
      db.prepare(
        `UPDATE knowledge_documents
         SET title = ?, source_type = ?, source_name = ?, content = ?, tags_json = ?, char_count = ?, chunk_count = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        nextTitle,
        nextSourceType,
        nextSourceName,
        nextContent,
        nextTagsJson,
        nextContent.length,
        chunks.length,
        now,
        existing.id
      );

      db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(existing.id);
      if (fts) {
        db.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(existing.id);
      }

      for (const ch of chunks) {
        const chunkId = `kchk-${crypto.randomUUID()}`;
        db.prepare(
          `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_estimate, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(chunkId, existing.id, ch.chunk_index, ch.content, ch.token_estimate, now);
        if (fts) {
          db.prepare(
            'INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)'
          ).run(chunkId, existing.id, nextTitle, ch.content, nextTags.join(' '));
        }
      }
    });

    res.json({
      id: existing.id,
      title: nextTitle,
      source_type: nextSourceType,
      source_name: nextSourceName,
      content: nextContent,
      tags: nextTags,
      chunk_count: chunks.length,
      created_at: existing.created_at,
      updated_at: now,
    });
  });

  router.delete('/knowledge/:id', (req, res) => {
    const db = getDb();
    const fts = hasFts5Support(db);
    let changes = 0;
    runInTransaction(db, () => {
      if (fts) {
        db.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(req.params.id);
      }
      db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(req.params.id);
      const result = db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(req.params.id);
      changes = Number(result.changes);
    });
    if (changes === 0) {
      res.status(404).json({ error: 'Knowledge document not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  router.post('/retrieval/query', (req, res) => {
    const db = getDb();
    const {
      query,
      include_memory,
      include_knowledge,
      max_memory_items,
      max_knowledge_chunks,
    } = req.body as {
      query?: string;
      include_memory?: boolean;
      include_knowledge?: boolean;
      max_memory_items?: number;
      max_knowledge_chunks?: number;
    };
    const retriever = new SqliteKeywordRetriever(db);
    const result = retriever.retrieve(String(query || ''), {
      includeMemory: include_memory !== false,
      includeKnowledge: include_knowledge !== false,
      maxMemoryItems: typeof max_memory_items === 'number' ? max_memory_items : 3,
      maxKnowledgeChunks: typeof max_knowledge_chunks === 'number' ? max_knowledge_chunks : 3,
    });
    res.json({
      ...result,
      formatted_context: formatRetrievedSystemContext(result) || null,
    });
  });

  // ---------------------------------------------------------------------------
  // Genesis Research
  // ---------------------------------------------------------------------------
  router.get('/research', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM research_projects ORDER BY updated_at DESC').all() as Array<{
      id: string;
      title: string;
      summary: string;
      status: string;
      tags_json: string;
      sources_json: string;
      notes: string;
      created_at: string;
      updated_at: string;
    }>;

    res.json(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        status: r.status,
        tags: parseJsonSafe<string[]>(r.tags_json, []),
        sources: parseJsonSafe(r.sources_json, []),
        notes: r.notes,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    );
  });

  router.post('/research', (req, res) => {
    const db = getDb();
    const { title, summary, status, tags, sources, notes } = req.body as {
      title?: string;
      summary?: string;
      status?: string;
      tags?: string[];
      sources?: unknown[];
      notes?: string;
    };
    if (!title?.trim()) {
      res.status(400).json({ error: 'Project title is required.' });
      return;
    }
    const now = new Date().toISOString();
    const id = `res-${crypto.randomUUID()}`;
    db.prepare(
      'INSERT INTO research_projects (id, title, summary, status, tags_json, sources_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      title.trim(),
      (summary || '').trim(),
      status || 'active',
      JSON.stringify(Array.isArray(tags) ? tags : []),
      JSON.stringify(Array.isArray(sources) ? sources : []),
      notes || '',
      now,
      now
    );

    res.status(201).json({
      id,
      title: title.trim(),
      summary: (summary || '').trim(),
      status: status || 'active',
      tags: Array.isArray(tags) ? tags : [],
      sources: Array.isArray(sources) ? sources : [],
      notes: notes || '',
      created_at: now,
      updated_at: now,
    });
  });

  router.put('/research/:id', (req, res) => {
    const db = getDb();
    const { title, summary, status, tags, sources, notes } = req.body as {
      title?: string;
      summary?: string;
      status?: string;
      tags?: string[];
      sources?: unknown[];
      notes?: string;
    };
    const now = new Date().toISOString();
    const result = db
      .prepare(
        'UPDATE research_projects SET title = ?, summary = ?, status = ?, tags_json = ?, sources_json = ?, notes = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        (title || '').trim(),
        (summary || '').trim(),
        status || 'active',
        JSON.stringify(Array.isArray(tags) ? tags : []),
        JSON.stringify(Array.isArray(sources) ? sources : []),
        notes || '',
        now,
        req.params.id
      );

    if (result.changes === 0) {
      res.status(404).json({ error: 'Research project not found.' });
      return;
    }
    const updatedRow = db
      .prepare('SELECT * FROM research_projects WHERE id = ?')
      .get(req.params.id) as {
      id: string;
      title: string;
      summary: string;
      status: string;
      tags_json: string;
      sources_json: string;
      notes: string;
      created_at: string;
      updated_at: string;
    };
    res.json({
      id: updatedRow.id,
      title: updatedRow.title,
      summary: updatedRow.summary,
      status: updatedRow.status,
      tags: parseJsonSafe<string[]>(updatedRow.tags_json, []),
      sources: parseJsonSafe(updatedRow.sources_json, []),
      notes: updatedRow.notes,
      created_at: updatedRow.created_at,
      updated_at: updatedRow.updated_at,
    });
  });

  router.delete('/research/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM research_projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Research project not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // World Intelligence Retrieval (Free Public Search, Scientific Preprints, RSS/Web)
  // ---------------------------------------------------------------------------
  router.get('/research/world/providers', (_req, res) => {
    res.json({
      providers: WORLD_INTELLIGENCE_PROVIDERS,
      direct_url_modes: ['rss', 'atom', 'html', 'text'],
      ssrf_protection: true,
      rate_limit_per_minute: 20,
    });
  });

  router.post('/research/world/search', async (req, res) => {
    const clientKey = getClientKey(req);
    const rl = checkWorldRateLimit(clientKey);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `World Intelligence retrieval rate limit reached. Retry in ${rl.retryAfterSec}s.`,
      });
      return;
    }

    const { provider, query, limit } = req.body as {
      provider?: string;
      query?: string;
      limit?: number;
    };

    const safeQuery = typeof query === 'string' ? query.trim() : '';
    if (!safeQuery || safeQuery.length > 240) {
      res.status(400).json({ ok: false, error: 'A search query (1–240 chars) is required.' });
      return;
    }

    const adapter = resolveWorldSearchProvider(provider || 'wikipedia');
    if (!adapter) {
      res.status(400).json({
        ok: false,
        error: `Unknown provider "${provider}". Supported providers: wikipedia, arxiv.`,
      });
      return;
    }

    const result = await adapter.search(safeQuery, Number(limit || 5));
    if (!result.ok) {
      logSystemEvent('warn', 'world_intelligence', `Search failed for provider=${adapter.descriptor.id}`, result.error);
    }
    res.json(result);
  });

  router.post('/research/world/fetch-url', async (req, res) => {
    const clientKey = getClientKey(req);
    const rl = checkWorldRateLimit(clientKey);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `World Intelligence retrieval rate limit reached. Retry in ${rl.retryAfterSec}s.`,
      });
      return;
    }

    const { url } = req.body as { url?: string };
    if (!url || typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ ok: false, error: 'A public http:// or https:// URL is required.' });
      return;
    }

    const result = await fetchPublicUrlOrFeed(url.trim());
    if (!result.ok && result.error?.includes('SSRF protection')) {
      logSystemEvent('warn', 'security', 'Blocked SSRF URL attempt in World Intelligence', result.error);
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Genesis Core Experimental Foundation Diagnostics
  // ---------------------------------------------------------------------------
  router.get('/genesis-core/status', (_req, res) => {
    const ckpt = inspectGenesisCheckpointOnDisk();
    let checkpointSizeBytes = 0;
    try {
      const resolvedCkpt = path.resolve(process.cwd(), ckpt.checkpoint_path);
      if (fs.existsSync(resolvedCkpt)) {
        checkpointSizeBytes = fs.statSync(resolvedCkpt).size;
      }
    } catch {
      checkpointSizeBytes = 0;
    }

    let tokenizerVocabSize: number | null = null;
    try {
      const resolvedTok = path.resolve(process.cwd(), ckpt.tokenizer_path);
      if (fs.existsSync(resolvedTok)) {
        const tokJson = JSON.parse(fs.readFileSync(resolvedTok, 'utf8')) as { vocab?: unknown[]; merges?: unknown[] };
        if (Array.isArray(tokJson.vocab)) {
          tokenizerVocabSize = tokJson.vocab.length;
        }
      }
    } catch {
      tokenizerVocabSize = null;
    }

    res.json({
      experimental: true,
      torch_available: false,
      runtime_note:
        'Node.js preview runtime inspects local checkpoints and tokenizer assets; PyTorch training & tensor inference execute in /backend/genesis_core.',
      trained: ckpt.trained,
      model_status: ckpt.model_status,
      trained_steps: ckpt.trained_steps,
      train_loss: ckpt.train_loss,
      val_loss: ckpt.val_loss,
      checkpoint_path: ckpt.checkpoint_path,
      checkpoint_exists: ckpt.checkpoint_exists,
      checkpoint_size_bytes: checkpointSizeBytes,
      tokenizer_path: ckpt.tokenizer_path,
      tokenizer_exists: ckpt.tokenizer_exists,
      tokenizer_vocab_size: tokenizerVocabSize,
      model_config: ckpt.model_config,
      ram_budget_note:
        'CPU presets (cpu_nano / cpu_micro / cpu_small) fit comfortably within 16 GB Windows host RAM without discrete GPU hardware.',
      capabilities: {
        operational: [
          'Deterministic UTF-8 byte baseline tokenizer & Laboratory budget inspector',
          'PyTorch decoder-only Transformer definition (backend/genesis_core/model.py)',
          'Byte-level BPE tokenizer trainer (backend/genesis_core/tokenizer.py)',
          'Local checkpoint verification, metadata parsing & model registry contracts',
          'OpenAI-compatible loopback inference adapter (llama.cpp / vLLM / Ollama local)',
        ],
        experimental_untrained: [
          'Out-of-the-box neural weights (requires local training on user corpus first)',
          'In-process Node.js PyTorch tensor forward pass (runs via Python backend runtime)',
        ],
      },
      architecture: {
        class_name: 'GenesisCoreTransformer',
        tokenizer_class: 'GenesisByteBPETokenizer',
        presets: {
          cpu_nano: { vocab_size: 512, context_length: 64, d_model: 64, n_heads: 4, n_layers: 2 },
          cpu_micro: { vocab_size: 1024, context_length: 128, d_model: 128, n_heads: 4, n_layers: 4 },
          cpu_small: { vocab_size: 2048, context_length: 256, d_model: 256, n_heads: 8, n_layers: 6 },
        },
      },
      training_command:
        'python backend/scripts/train_genesis_core.py --corpus ./docs --preset cpu_nano --steps 100',
    });
  });

  // ---------------------------------------------------------------------------
  // Genesis Model Manager
  // ---------------------------------------------------------------------------
  router.get('/models', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM models ORDER BY created_at ASC').all() as Array<{
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
      created_at: string;
      updated_at: string;
    }>;

    res.json(
      rows.map((r) => ({
        ...r,
        metadata: parseJsonSafe(r.metadata_json, {}),
      }))
    );
  });

  router.post('/models', (req, res) => {
    const db = getDb();
    const {
      name,
      provider,
      model_type,
      local_path,
      endpoint_url,
      context_length,
      quantization,
      parameter_count,
      notes,
    } = req.body as {
      name?: string;
      provider?: string;
      model_type?: string;
      local_path?: string;
      endpoint_url?: string;
      context_length?: number;
      quantization?: string;
      parameter_count?: string;
      notes?: string;
    };

    if (!name?.trim()) {
      res.status(400).json({ error: 'Model name is required.' });
      return;
    }

    if (endpoint_url && endpoint_url.trim()) {
      const check = isLocalInferenceUrlSafe(endpoint_url.trim());
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }

    const now = new Date().toISOString();
    const id = `model-${crypto.randomUUID()}`;
    const metadata = {
      architecture: provider === 'genesis_core' ? 'GenesisDecoderArchitecture' : 'CustomLocalModel',
      weights_verified: false,
      notes: notes || '',
    };

    db.prepare(
      `INSERT INTO models (
        id, name, provider, model_type, local_path, endpoint_url, status, loading_status,
        context_length, quantization, parameter_count, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name.trim(),
      provider || 'gguf_local',
      model_type || 'Local Foundation Weights',
      (local_path || '').trim(),
      (endpoint_url || '').trim(),
      'registered',
      'unloaded',
      Number(context_length || 8192),
      quantization || 'Q4_K_M',
      parameter_count || 'Unspecified',
      JSON.stringify(metadata),
      now,
      now
    );

    res.status(201).json({
      id,
      name: name.trim(),
      provider: provider || 'gguf_local',
      model_type: model_type || 'Local Foundation Weights',
      local_path: (local_path || '').trim(),
      endpoint_url: (endpoint_url || '').trim(),
      status: 'registered',
      loading_status: 'unloaded',
      context_length: Number(context_length || 8192),
      quantization: quantization || 'Q4_K_M',
      parameter_count: parameter_count || 'Unspecified',
      metadata,
      created_at: now,
      updated_at: now,
    });
  });

  router.put('/models/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          name: string;
          provider: string;
          local_path: string;
          endpoint_url: string;
          context_length: number;
          metadata_json: string;
        }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Model not found.' });
      return;
    }

    const { endpoint_url, context_length, name, local_path } = req.body as {
      endpoint_url?: string;
      context_length?: number;
      name?: string;
      local_path?: string;
    };

    const nextEndpoint = endpoint_url !== undefined ? endpoint_url.trim() : existing.endpoint_url;
    if (nextEndpoint) {
      const check = isLocalInferenceUrlSafe(nextEndpoint);
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }

    const nextName = name !== undefined ? name.trim() || existing.name : existing.name;
    const nextPath = local_path !== undefined ? local_path.trim() : existing.local_path;
    const nextContext =
      context_length !== undefined
        ? Math.min(131072, Math.max(512, Math.round(Number(context_length))))
        : existing.context_length;
    const now = new Date().toISOString();

    db.prepare(
      'UPDATE models SET name = ?, local_path = ?, endpoint_url = ?, context_length = ?, updated_at = ? WHERE id = ?'
    ).run(nextName, nextPath, nextEndpoint, nextContext, now, existing.id);

    const updated = db.prepare('SELECT * FROM models WHERE id = ?').get(existing.id) as Record<string, unknown>;
    res.json({
      ...updated,
      metadata: parseJsonSafe(String(updated.metadata_json || '{}'), {}),
    });
  });

  router.post('/models/:id/probe', async (req, res) => {
    const db = getDb();
    const settings = getCoreSettings();
    const resolved = resolveModelAdapter(db, req.params.id, settings.inference_endpoint_url);
    if ('error' in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    const { adapter, model } = resolved;
    const now = new Date().toISOString();
    const probe = await adapter.healthProbe();

    if (model.provider === 'genesis_core') {
      const payloadStatus = (probe.payload || {}) as { trained?: boolean; model_status?: string };
      res.json({
        id: model.id,
        reachable: false,
        status: 'placeholder',
        loading_status: 'unloaded',
        detected_models: probe.detected_models,
        server_model: probe.server_model ?? null,
        experimental: true,
        trained: Boolean(payloadStatus.trained),
        model_status: payloadStatus.model_status || 'untrained_experimental',
        message: probe.message,
      });
      return;
    }

    const existingMeta = parseJsonSafe<Record<string, unknown>>(model.metadata_json, {});
    const updatedMeta = {
      ...existingMeta,
      detected_models: probe.detected_models,
      server_model: probe.server_model ?? null,
      last_probe_at: now,
    };

    const hasEndpoint = Boolean((model.endpoint_url || '').trim() || (model.id === 'local-inference-http' && settings.inference_endpoint_url));
    const nextStatus = !hasEndpoint ? 'registered' : probe.reachable ? 'connected' : 'unreachable';
    const nextLoading = probe.reachable ? 'loaded' : 'unloaded';

    db.prepare(
      'UPDATE models SET status = ?, loading_status = ?, metadata_json = ?, updated_at = ? WHERE id = ?'
    ).run(nextStatus, nextLoading, JSON.stringify(updatedMeta), now, model.id);

    res.json({
      id: model.id,
      reachable: probe.reachable,
      status: nextStatus,
      loading_status: nextLoading,
      detected_models: probe.detected_models,
      server_model: probe.server_model ?? null,
      message: probe.message,
      payload: probe.payload,
    });
  });

  router.delete('/models/:id', (req, res) => {
    const db = getDb();
    if (req.params.id === 'genesis-core-placeholder') {
      res.status(400).json({ error: 'Core placeholder adapter cannot be removed.' });
      return;
    }
    const result = db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Model not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // Genesis Agent & Sandboxed Tool Execution
  // ---------------------------------------------------------------------------
  router.get('/agents', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Array<{
      id: string;
      name: string;
      role: string;
      description: string;
      allowed_tools_json: string;
      sandbox_policy_json: string;
      system_prompt: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        description: r.description,
        allowed_tools: parseJsonSafe<string[]>(r.allowed_tools_json, []),
        sandbox_policy: parseJsonSafe(r.sandbox_policy_json, {
          allow_network: false,
          allow_filesystem_write: false,
          allow_shell_execution: false,
          max_steps: 4,
          workspace_scope: './data',
        }),
        system_prompt: r.system_prompt,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    );
  });

  router.post('/agents', (req, res) => {
    const db = getDb();
    const { name, role, description, allowed_tools, sandbox_policy, system_prompt } = req.body as {
      name?: string;
      role?: string;
      description?: string;
      allowed_tools?: string[];
      sandbox_policy?: Record<string, unknown>;
      system_prompt?: string;
    };

    if (!name?.trim() || !role?.trim()) {
      res.status(400).json({ error: 'Agent name and role are required.' });
      return;
    }

    const now = new Date().toISOString();
    const id = `agent-${crypto.randomUUID()}`;
    const operationalTools = new Set(defaultAgentManager.getAllowedOperationalToolIds());
    const safeTools = Array.isArray(allowed_tools)
      ? allowed_tools.filter((t) => operationalTools.has(t))
      : ['health_check'];
    const safePolicy = {
      allow_network: false,
      allow_filesystem_write: safeTools.includes('create_document'),
      allow_shell_execution: false,
      max_steps: Math.min(12, Math.max(1, Number(sandbox_policy?.max_steps || 6))),
      workspace_scope: './data/agent_workspace',
    };

    db.prepare(
      'INSERT INTO agents (id, name, role, description, allowed_tools_json, sandbox_policy_json, system_prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      name.trim(),
      role.trim(),
      (description || '').trim(),
      JSON.stringify(safeTools),
      JSON.stringify(safePolicy),
      system_prompt || '',
      'ready',
      now,
      now
    );

    res.status(201).json({
      id,
      name: name.trim(),
      role: role.trim(),
      description: (description || '').trim(),
      allowed_tools: safeTools,
      sandbox_policy: safePolicy,
      system_prompt: system_prompt || '',
      status: 'ready',
      created_at: now,
      updated_at: now,
    });
  });

  router.post('/agents/:id/dry-run', (req, res) => {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          name: string;
          allowed_tools_json: string;
          sandbox_policy_json: string;
        }
      | undefined;

    if (!agent) {
      res.status(404).json({ error: 'Agent not found.' });
      return;
    }

    const { task } = req.body as { task?: string };
    const allowedTools = parseJsonSafe<string[]>(agent.allowed_tools_json, []);
    const policy = parseJsonSafe<{ max_steps: number }>(agent.sandbox_policy_json, { max_steps: 4 });
    const modelsCount = (db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number }).c;
    const tokenStats = inspectTokensServer(task || '');

    const trace = [
      {
        step: 1,
        action: 'Sandbox Policy Verification',
        status: 'executed',
        detail: `Network disabled · Filesystem write disabled · Shell disabled · Step budget: ${policy.max_steps}`,
      },
      {
        step: 2,
        action: 'Deterministic Input Inspection',
        status: 'executed',
        detail: `Task tokenized: ${tokenStats.token_count} tokens (${tokenStats.byte_count} bytes). Allowed tools: ${allowedTools.join(', ') || 'None'}.`,
      },
      {
        step: 3,
        action: 'Local Model Registry Check',
        status: 'executed',
        detail: `Verified ${modelsCount} registered model manifest(s). Active inference weights: None.`,
      },
      {
        step: 4,
        action: 'Autonomous Reasoning Step',
        status: 'paused_no_model',
        detail:
          'Execution paused cleanly. Autonomous planning requires an active GENESIS CORE model or local inference server.',
      },
    ];

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      mode: 'sandbox_dry_run',
      trace,
    });
  });

  router.delete('/agents/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Agent not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // Step 07: Genesis Agent Operating System (Tools, Tasks, Approvals, History)
  // ---------------------------------------------------------------------------
  router.get('/agent-tools', (_req, res) => {
    res.json(defaultAgentManager.listTools());
  });

  router.get('/agent-tasks', (req, res) => {
    const db = getDb();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(defaultAgentManager.listTasks(db, status));
  });

  router.post('/agent-tasks', async (req, res) => {
    const db = getDb();
    const {
      agent_id,
      goal,
      title,
      target_file_path,
      document_filename,
      code_snippet,
      max_retries,
      auto_run,
    } = req.body as {
      agent_id?: string;
      goal?: string;
      title?: string;
      target_file_path?: string;
      document_filename?: string;
      code_snippet?: string;
      max_retries?: number;
      auto_run?: boolean;
    };

    if (!agent_id?.trim() || !goal?.trim()) {
      res.status(400).json({ error: 'agent_id and goal are required.' });
      return;
    }

    try {
      const detail = await defaultAgentManager.createAndPlanTask(db, {
        agentId: agent_id.trim(),
        goal: goal.trim(),
        title,
        targetFilePath: target_file_path,
        documentFilename: document_filename,
        codeSnippet: code_snippet,
        maxRetries: max_retries,
        autoRun: Boolean(auto_run),
      });
      res.status(201).json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create agent task.';
      const status = msg.includes('not found') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.get('/agent-tasks/:id', (req, res) => {
    const db = getDb();
    const detail = defaultAgentManager.getTaskDetail(db, req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'Agent task not found.' });
      return;
    }
    res.json(detail);
  });

  router.post('/agent-tasks/:id/run', async (req, res) => {
    const db = getDb();
    try {
      const detail = await defaultAgentManager.runTask(db, req.params.id);
      res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Task execution failed.';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/agent-tasks/:id/steps/:stepId/approve', async (req, res) => {
    const db = getDb();
    const { approved, note, resume } = req.body as {
      approved?: boolean;
      note?: string;
      resume?: boolean;
    };
    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'Boolean approved field is required.' });
      return;
    }
    try {
      const detail = await defaultAgentManager.handleStepApproval(db, {
        taskId: req.params.id,
        stepId: req.params.stepId,
        approved,
        note,
        resumeExecution: resume !== false,
      });
      res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Approval update failed.';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/agent-tasks/:id/cancel', (req, res) => {
    const db = getDb();
    try {
      const detail = defaultAgentManager.cancelTask(db, req.params.id);
      res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel task.';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/agent-tasks/:id/save-memory', (req, res) => {
    const db = getDb();
    const { approved, title, content, category, tags } = req.body as {
      approved?: boolean;
      title?: string;
      content?: string;
      category?: string;
      tags?: string[];
    };
    try {
      const saved = defaultAgentManager.saveTaskResultToMemory(db, {
        taskId: req.params.id,
        approved: approved === true,
        title,
        content,
        category,
        tags,
      });
      res.status(201).json(saved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save task memory.';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.delete('/agent-tasks/:id', (req, res) => {
    const db = getDb();
    const deleted = defaultAgentManager.deleteTask(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Agent task not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  router.get('/agent-history', (req, res) => {
    const db = getDb();
    const taskId = typeof req.query.task_id === 'string' ? req.query.task_id : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 80;
    res.json(defaultAgentManager.listHistory(db, { taskId, limit }));
  });

  // ---------------------------------------------------------------------------
  // Genesis Laboratory & Tokenizer Inspection
  // ---------------------------------------------------------------------------
  router.post('/laboratory/tokenize', (req, res) => {
    const { text, context_limit } = req.body as { text?: string; context_limit?: number };
    const result = inspectTokensServer(typeof text === 'string' ? text : '', Number(context_limit || 8192));
    res.json(result);
  });

  router.get('/laboratory', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM laboratory_items ORDER BY updated_at DESC').all() as Array<{
      id: string;
      kind: string;
      name: string;
      content: string;
      schema_json: string;
      metrics_json: string;
      created_at: string;
      updated_at: string;
    }>;

    res.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        content: r.content,
        schema_json: r.schema_json,
        metrics: parseJsonSafe(r.metrics_json, {}),
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    );
  });

  router.post('/laboratory', (req, res) => {
    const db = getDb();
    const { kind, name, content, schema_json, metrics } = req.body as {
      kind?: string;
      name?: string;
      content?: string;
      schema_json?: string;
      metrics?: Record<string, unknown>;
    };

    if (!name?.trim() || !content?.trim()) {
      res.status(400).json({ error: 'Name and content are required.' });
      return;
    }

    const now = new Date().toISOString();
    const id = `lab-${crypto.randomUUID()}`;
    db.prepare(
      'INSERT INTO laboratory_items (id, kind, name, content, schema_json, metrics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      kind || 'prompt_template',
      name.trim(),
      content,
      schema_json || '{}',
      JSON.stringify(metrics || {}),
      now,
      now
    );

    res.status(201).json({
      id,
      kind: kind || 'prompt_template',
      name: name.trim(),
      content,
      schema_json: schema_json || '{}',
      metrics: metrics || {},
      created_at: now,
      updated_at: now,
    });
  });

  router.delete('/laboratory/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM laboratory_items WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Laboratory item not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // Genesis Multimodal Intelligence (Step 10), Engineering (Step 11) & Creator Studio (Step 09)
  // ---------------------------------------------------------------------------
  router.use('/multimodal', createMultimodalRouter(getCoreSettings));
  router.use('/engineering', createEngineeringRouter(getCoreSettings));
  router.use('/creator', createCreatorStudioRouter(getCoreSettings));

  router.get('/creator', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM creator_artifacts ORDER BY updated_at DESC').all();
    res.json(rows);
  });

  router.post('/creator', (req, res) => {
    const db = getDb();
    const { title, artifact_type, language, content } = req.body as {
      title?: string;
      artifact_type?: string;
      language?: string;
      content?: string;
    };

    if (!title?.trim()) {
      res.status(400).json({ error: 'Artifact title is required.' });
      return;
    }

    const now = new Date().toISOString();
    const id = `art-${crypto.randomUUID()}`;
    db.prepare(
      'INSERT INTO creator_artifacts (id, title, artifact_type, language, content, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, title.trim(), artifact_type || 'markdown', language || 'markdown', content || '', 1, now, now);

    const created = db.prepare('SELECT * FROM creator_artifacts WHERE id = ?').get(id);
    res.status(201).json(created);
  });

  router.put('/creator/:id', (req, res) => {
    const db = getDb();
    const { title, artifact_type, language, content } = req.body as {
      title?: string;
      artifact_type?: string;
      language?: string;
      content?: string;
    };

    const now = new Date().toISOString();
    const result = db
      .prepare(
        'UPDATE creator_artifacts SET title = ?, artifact_type = ?, language = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ?'
      )
      .run(
        (title || 'Untitled').trim(),
        artifact_type || 'markdown',
        language || 'markdown',
        content || '',
        now,
        req.params.id
      );

    if (result.changes === 0) {
      res.status(404).json({ error: 'Artifact not found.' });
      return;
    }

    const updated = db.prepare('SELECT * FROM creator_artifacts WHERE id = ?').get(req.params.id);
    res.json(updated);
  });

  router.delete('/creator/:id', (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM creator_artifacts WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Artifact not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // ---------------------------------------------------------------------------
  // System Settings, Local Auth & DB Snapshot
  // ---------------------------------------------------------------------------
  router.get('/settings', (_req, res) => {
    const settings = getCoreSettings();
    res.json(sanitizeSettingsForClient(settings));
  });

  router.put('/settings', (req, res) => {
    const db = getDb();
    const current = getCoreSettings();
    const body = req.body as Partial<StoredCoreSettings> & {
      new_passcode?: string;
      current_passcode?: string;
    };

    if (body.inference_endpoint_url !== undefined && body.inference_endpoint_url.trim() !== '') {
      const check = isLocalInferenceUrlSafe(body.inference_endpoint_url.trim());
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }

    for (const urlField of ['voice_stt_endpoint_url', 'voice_tts_endpoint_url', 'vision_endpoint_url'] as const) {
      const val = body[urlField];
      if (typeof val === 'string' && val.trim() !== '') {
        const check = isLocalInferenceUrlSafe(val.trim());
        if (!check.valid) {
          res.status(400).json({ error: `${urlField}: ${check.reason}` });
          return;
        }
      }
    }

    const wantsPasscodeChange = typeof body.new_passcode === 'string' && body.new_passcode.trim().length > 0;
    const wantsAuthToggle =
      typeof body.local_auth_enabled === 'boolean' && body.local_auth_enabled !== current.local_auth_enabled;

    // Require existing passcode verification before modifying or disabling authentication
    if (current.passcode_hash && (wantsPasscodeChange || (wantsAuthToggle && current.local_auth_enabled))) {
      const provided = typeof body.current_passcode === 'string' ? body.current_passcode : '';
      if (!provided) {
        res.status(403).json({ error: 'Current passcode is required to modify or disable authentication.' });
        return;
      }
      const candidate = hashPasscode(provided, current.passcode_salt);
      const matches = crypto.timingSafeEqual(Buffer.from(candidate.hash), Buffer.from(current.passcode_hash));
      if (!matches) {
        res.status(403).json({ error: 'Current passcode verification failed.' });
        return;
      }
    }

    let passcodeHash = current.passcode_hash;
    let passcodeSalt = current.passcode_salt;

    if (wantsPasscodeChange) {
      const trimmedPasscode = body.new_passcode!.trim();
      if (trimmedPasscode.length < 6) {
        res.status(400).json({ error: 'Local passcode must be at least 6 characters.' });
        return;
      }
      const hashed = hashPasscode(trimmedPasscode);
      passcodeHash = hashed.hash;
      passcodeSalt = hashed.salt;
    }

    const next: StoredCoreSettings = {
      operator_name: (body.operator_name ?? current.operator_name).trim() || 'Local Operator',
      local_auth_enabled:
        typeof body.local_auth_enabled === 'boolean' ? body.local_auth_enabled : current.local_auth_enabled,
      passcode_hash: passcodeHash,
      passcode_salt: passcodeSalt,
      inference_endpoint_url: (body.inference_endpoint_url ?? current.inference_endpoint_url).trim(),
      prefer_local_inference:
        typeof body.prefer_local_inference === 'boolean'
          ? body.prefer_local_inference
          : current.prefer_local_inference,
      active_model_id:
        typeof body.active_model_id === 'string' && body.active_model_id.trim()
          ? body.active_model_id.trim()
          : current.active_model_id,
      chat_use_memory:
        typeof body.chat_use_memory === 'boolean' ? body.chat_use_memory : current.chat_use_memory,
      chat_use_knowledge:
        typeof body.chat_use_knowledge === 'boolean' ? body.chat_use_knowledge : current.chat_use_knowledge,
      inference_temperature: Math.min(
        2,
        Math.max(0, Number(body.inference_temperature ?? current.inference_temperature ?? 0.2))
      ),
      inference_max_tokens: Math.min(
        8192,
        Math.max(32, Math.round(Number(body.inference_max_tokens ?? current.inference_max_tokens ?? 512)))
      ),
      inference_timeout_ms: Math.min(
        120000,
        Math.max(1000, Math.round(Number(body.inference_timeout_ms ?? current.inference_timeout_ms ?? 30000)))
      ),
      max_upload_mb: Math.min(25, Math.max(1, Number(body.max_upload_mb ?? current.max_upload_mb))),
      allowed_extensions: Array.isArray(body.allowed_extensions)
        ? body.allowed_extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
        : current.allowed_extensions,
      sandbox_strict_mode:
        typeof body.sandbox_strict_mode === 'boolean' ? body.sandbox_strict_mode : current.sandbox_strict_mode,
      voice_sample_rate: Number(body.voice_sample_rate ?? current.voice_sample_rate),
      voice_vad_threshold: Number(body.voice_vad_threshold ?? current.voice_vad_threshold),
      voice_stt_adapter: body.voice_stt_adapter ?? current.voice_stt_adapter,
      voice_tts_adapter: body.voice_tts_adapter ?? current.voice_tts_adapter,
      voice_stt_language:
        typeof body.voice_stt_language === 'string' && body.voice_stt_language.trim()
          ? body.voice_stt_language.trim()
          : current.voice_stt_language,
      voice_tts_voice:
        typeof body.voice_tts_voice === 'string' ? body.voice_tts_voice : current.voice_tts_voice,
      voice_tts_rate: Math.min(
        2.0,
        Math.max(0.5, Number(body.voice_tts_rate ?? current.voice_tts_rate ?? 1.0))
      ),
      voice_auto_speak:
        typeof body.voice_auto_speak === 'boolean' ? body.voice_auto_speak : current.voice_auto_speak,
      voice_stt_endpoint_url:
        typeof body.voice_stt_endpoint_url === 'string'
          ? body.voice_stt_endpoint_url.trim()
          : current.voice_stt_endpoint_url,
      voice_tts_endpoint_url:
        typeof body.voice_tts_endpoint_url === 'string'
          ? body.voice_tts_endpoint_url.trim()
          : current.voice_tts_endpoint_url,
      vision_endpoint_url:
        typeof body.vision_endpoint_url === 'string'
          ? body.vision_endpoint_url.trim()
          : current.vision_endpoint_url,
      ocr_enabled:
        typeof body.ocr_enabled === 'boolean' ? body.ocr_enabled : current.ocr_enabled,
      step10_media_defaults_applied: true,
      first_run_completed:
        typeof body.first_run_completed === 'boolean'
          ? body.first_run_completed
          : Boolean(current.first_run_completed),
    };

    if (next.local_auth_enabled && !next.passcode_hash) {
      res.status(400).json({ error: 'Set a local passcode before enabling local session lock.' });
      return;
    }

    db.prepare('INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'core_config',
      JSON.stringify(next),
      new Date().toISOString()
    );

    let sessionToken: string | undefined;
    let expiresAt: string | undefined;
    if (wantsPasscodeChange || (wantsAuthToggle && !next.local_auth_enabled)) {
      clearAllSessions(db);
      clearSessionCookie(req, res);
    }
    if (next.local_auth_enabled && (!current.local_auth_enabled || wantsPasscodeChange)) {
      const session = createSession(db);
      sessionToken = session.token;
      expiresAt = session.expires_at;
      setSessionCookie(req, res, session.token);
    }

    res.json({
      ...sanitizeSettingsForClient(next),
      ...(sessionToken ? { session_token: sessionToken, expires_at: expiresAt } : {}),
    });
  });

  router.put('/settings/first-run', (req, res) => {
    const db = getDb();
    const current = getCoreSettings();
    const body = req.body as {
      operator_name?: string;
      prefer_local_inference?: boolean;
      enable_local_auth?: boolean;
      new_passcode?: string;
    };

    let passcodeHash = current.passcode_hash;
    let passcodeSalt = current.passcode_salt;
    let localAuthEnabled = current.local_auth_enabled;

    if (body.enable_local_auth && !current.passcode_hash) {
      const trimmed = typeof body.new_passcode === 'string' ? body.new_passcode.trim() : '';
      if (trimmed.length < 6) {
        res.status(400).json({ error: 'Passcode must be at least 6 characters when enabling session lock.' });
        return;
      }
      const hashed = hashPasscode(trimmed);
      passcodeHash = hashed.hash;
      passcodeSalt = hashed.salt;
      localAuthEnabled = true;
    }

    const next: StoredCoreSettings = {
      ...current,
      operator_name: (body.operator_name ?? current.operator_name).trim() || current.operator_name,
      prefer_local_inference:
        typeof body.prefer_local_inference === 'boolean'
          ? body.prefer_local_inference
          : current.prefer_local_inference,
      local_auth_enabled: localAuthEnabled,
      passcode_hash: passcodeHash,
      passcode_salt: passcodeSalt,
      first_run_completed: true,
    };

    db.prepare('INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'core_config',
      JSON.stringify(next),
      new Date().toISOString()
    );

    let sessionToken: string | undefined;
    let expiresAt: string | undefined;
    if (next.local_auth_enabled && !current.local_auth_enabled) {
      const session = createSession(db);
      sessionToken = session.token;
      expiresAt = session.expires_at;
      setSessionCookie(req, res, session.token);
    }

    logSystemEvent('info', 'onboarding', 'First-run setup completed', {
      operator_name: next.operator_name,
      local_auth_enabled: next.local_auth_enabled,
    });

    res.json({
      ...sanitizeSettingsForClient(next),
      ...(sessionToken ? { session_token: sessionToken, expires_at: expiresAt } : {}),
    });
  });

  router.post('/settings/verify-passcode', (req, res) => {
    const clientKey = getClientKey(req);
    const limit = checkRateLimit(clientKey);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({
        unlocked: false,
        error: `Too many failed passcode attempts. Try again in ${limit.retryAfterSec} seconds.`,
      });
      return;
    }

    const db = getDb();
    const settings = getCoreSettings();
    const { passcode } = req.body as { passcode?: string };
    if (!settings.local_auth_enabled || !settings.passcode_hash) {
      res.json({ unlocked: true });
      return;
    }
    if (!passcode) {
      recordFailedAttempt(clientKey);
      res.status(401).json({ unlocked: false, error: 'Passcode required.' });
      return;
    }
    const candidate = hashPasscode(passcode, settings.passcode_salt);
    const matches = crypto.timingSafeEqual(Buffer.from(candidate.hash), Buffer.from(settings.passcode_hash));
    if (!matches) {
      recordFailedAttempt(clientKey);
      logSystemEvent('warn', 'security', 'Failed local passcode attempt');
      res.status(401).json({ unlocked: false, error: 'Invalid local operator passcode.' });
      return;
    }

    clearFailedAttempts(clientKey);
    const session = createSession(db);
    setSessionCookie(req, res, session.token);
    res.json({
      unlocked: true,
      session_token: session.token,
      expires_at: session.expires_at,
    });
  });

  router.get('/settings/export-db', (_req, res) => {
    const db = getDb();
    const snapshot = {
      exported_at: new Date().toISOString(),
      platform: 'Project Genesis Step 12',
      conversations: db.prepare('SELECT * FROM conversations').all(),
      messages: db.prepare('SELECT * FROM messages').all(),
      memory_entries: db.prepare('SELECT * FROM memory_entries').all(),
      knowledge_documents: db.prepare('SELECT * FROM knowledge_documents').all(),
      knowledge_chunks: db.prepare('SELECT * FROM knowledge_chunks').all(),
      research_projects: db.prepare('SELECT * FROM research_projects').all(),
      models: db.prepare('SELECT * FROM models').all(),
      agents: db.prepare('SELECT * FROM agents').all(),
      agent_tasks: db.prepare('SELECT * FROM agent_tasks').all(),
      agent_task_steps: db.prepare('SELECT * FROM agent_task_steps').all(),
      agent_execution_history: db.prepare('SELECT * FROM agent_execution_history').all(),
      laboratory_items: db.prepare('SELECT * FROM laboratory_items').all(),
      creator_artifacts: db.prepare('SELECT * FROM creator_artifacts').all(),
      creator_projects: db.prepare('SELECT * FROM creator_projects').all(),
      creator_project_files: db.prepare('SELECT * FROM creator_project_files').all(),
      creator_revisions: db.prepare('SELECT * FROM creator_revisions').all(),
      multimodal_assets: db.prepare('SELECT * FROM multimodal_assets').all(),
      scientific_experiments: db.prepare('SELECT * FROM scientific_experiments').all(),
      engineering_calculations: db.prepare('SELECT * FROM engineering_calculations').all(),
      settings: sanitizeSettingsForClient(getCoreSettings()),
    };
    res.json(snapshot);
  });

  router.get('/settings/export-sqlite', (_req, res) => {
    const db = getDb();
    let tempPath = '';
    try {
      const backup = createBinaryBackupTempFile(db);
      tempPath = backup.tempPath;
      const bytes = fs.readFileSync(tempPath);
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/x-sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="genesis_backup_${dateStr}.db"`);
      res.setHeader('Content-Length', String(bytes.byteLength));
      res.send(bytes);
    } catch (err) {
      logSystemEvent('error', 'backup', 'Failed binary SQLite backup export', err);
      res.status(500).json({ error: 'Failed to create binary SQLite backup snapshot.' });
    } finally {
      if (tempPath) {
        try {
          fs.rmSync(path.dirname(tempPath), { recursive: true, force: true });
        } catch {
          // Ignore temp cleanup failure
        }
      }
    }
  });

  router.post('/settings/restore-db', (req, res) => {
    const db = getDb();
    const payload = req.body as Record<string, unknown>;
    try {
      const result = restoreDatabaseSnapshot(db, payload);
      logSystemEvent('info', 'recovery', 'Database JSON snapshot restored', result.restored_tables);
      res.json({ restored: true, ...result });
    } catch (err) {
      logSystemEvent('error', 'recovery', 'Database JSON snapshot restore failed', err);
      res.status(400).json({
        restored: false,
        error: err instanceof Error ? err.message : 'Failed to restore JSON backup.',
      });
    }
  });

  router.post('/settings/reset', (_req, res) => {
    const db = getDb();
    resetWorkspaceData(db);
    logSystemEvent('info', 'recovery', 'Workspace reset to starter defaults');
    res.json({ reset: true, timestamp: new Date().toISOString() });
  });

  // ---------------------------------------------------------------------------
  // System Reliability: Integrity Check & Structured Logs
  // ---------------------------------------------------------------------------
  router.post('/system/integrity-check', (_req, res) => {
    const db = getDb();
    const report = runDatabaseIntegrityCheck(db);
    if (!report.ok) {
      logSystemEvent('error', 'database', 'SQLite integrity check detected issues', report);
    }
    res.json(report);
  });

  router.get('/system/logs', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 60;
    const level = typeof req.query.level === 'string' ? req.query.level : 'all';
    const safeLevel = level === 'info' || level === 'warn' || level === 'error' ? level : 'all';
    res.json({
      summary: getSystemLogSummary(),
      logs: getRecentSystemLogs({
        limit: Number.isFinite(limit) ? limit : 60,
        level: safeLevel,
      }),
    });
  });

  router.delete('/system/logs', (_req, res) => {
    clearBufferedLogs();
    res.json({ cleared: true });
  });

  return router;
}
