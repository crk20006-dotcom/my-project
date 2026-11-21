import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { DatabaseSync } from 'node:sqlite';
import { getDbPath, hasFts5Support } from '../db.ts';
import { inspectTokensServer } from '../ai/interfaces.ts';
import { detectSensitiveSecret, SqliteKeywordRetriever } from '../ai/memoryRetrieval.ts';

export type ToolCategory =
  | 'file_system'
  | 'document'
  | 'code_execution'
  | 'knowledge'
  | 'memory'
  | 'local_app'
  | 'future_extension';

export type ToolRiskLevel = 'read_only' | 'consequential' | 'reserved_stub';

export interface AgentToolContext {
  db: DatabaseSync;
  agentId: string;
  taskId: string;
  workspaceRoot?: string;
}

export interface AgentToolResult {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
}

export interface AgentToolDefinition {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  risk_level: ToolRiskLevel;
  requires_approval: boolean;
  safe_retryable: boolean;
  operational: boolean;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: AgentToolContext) => Promise<AgentToolResult> | AgentToolResult;
}

export interface PublicToolDescriptor {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  risk_level: ToolRiskLevel;
  requires_approval: boolean;
  safe_retryable: boolean;
  operational: boolean;
  input_schema: Record<string, unknown>;
}

const MAX_READ_BYTES = 64 * 1024;
const MAX_DOC_CHARS = 50_000;
const MAX_CODE_CHARS = 2_500;

export function getApprovedAgentWorkspaceDir(customRoot?: string): string {
  const base = customRoot
    ? path.resolve(customRoot)
    : path.resolve(process.cwd(), 'data', 'agent_workspace');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

export function resolveSafeWorkspacePath(
  requestedPath: string,
  options?: { allowDocsFolder?: boolean; customRoot?: string; requireSubdir?: string }
): { ok: true; resolved: string; displayPath: string } | { ok: false; error: string } {
  const cleaned = String(requestedPath || '').trim();
  if (!cleaned) {
    return { ok: false, error: 'File path is required.' };
  }
  if (cleaned.includes('\0') || path.isAbsolute(cleaned)) {
    return { ok: false, error: 'Absolute paths and null bytes are blocked by sandbox policy.' };
  }
  const normalizedInput = cleaned.replace(/\\/g, '/').replace(/^\.\//, '');
  const lower = normalizedInput.toLowerCase();
  if (
    lower.includes('..') ||
    lower.endsWith('.db') ||
    lower.includes('.db-') ||
    lower.startsWith('.env') ||
    lower.includes('/.env')
  ) {
    return { ok: false, error: 'Path traversal, database files, and environment files are blocked.' };
  }

  const workspaceRoot = getApprovedAgentWorkspaceDir(options?.customRoot);
  const docsRoot = path.resolve(process.cwd(), 'docs');

  // Allow reading from ./docs if prefix is docs/ and read-only
  if (options?.allowDocsFolder && (lower === 'docs' || lower.startsWith('docs/'))) {
    const rel = normalizedInput.slice(5);
    const target = path.resolve(docsRoot, rel);
    const diff = path.relative(docsRoot, target);
    if (diff.startsWith('..') || path.isAbsolute(diff)) {
      return { ok: false, error: 'Resolved path escapes approved docs directory.' };
    }
    return { ok: true, resolved: target, displayPath: `docs/${diff.replace(/\\/g, '/')}` };
  }

  const subRoot = options?.requireSubdir
    ? path.resolve(workspaceRoot, options.requireSubdir)
    : workspaceRoot;
  if (!fs.existsSync(subRoot)) {
    fs.mkdirSync(subRoot, { recursive: true });
  }

  const stripped = normalizedInput.startsWith('data/agent_workspace/')
    ? normalizedInput.slice('data/agent_workspace/'.length)
    : normalizedInput.startsWith('agent_workspace/')
      ? normalizedInput.slice('agent_workspace/'.length)
      : normalizedInput;

  const target = path.resolve(subRoot, stripped);
  const rel = path.relative(subRoot, target);
  if (!rel || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Path must resolve strictly inside approved agent workspace.' };
  }
  return {
    ok: true,
    resolved: target,
    displayPath: options?.requireSubdir
      ? `data/agent_workspace/${options.requireSubdir}/${rel.replace(/\\/g, '/')}`
      : `data/agent_workspace/${rel.replace(/\\/g, '/')}`,
  };
}

function sanitizeSafeDocFilename(rawName: string): string {
  const base = path.basename(String(rawName || 'agent_report.md').trim());
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safe) return 'agent_report.md';
  const ext = path.extname(safe).toLowerCase();
  if (!['.md', '.txt', '.json', '.csv'].includes(ext)) {
    return `${safe}.md`;
  }
  return safe;
}

function listFilesRecursiveBounded(dir: string, root: string, limit = 40): Array<{ path: string; size_bytes: number }> {
  const results: Array<{ path: string; size_bytes: number }> = [];
  if (!fs.existsSync(dir)) return results;

  const walk = (current: string) => {
    if (results.length >= limit) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        results.push({
          path: path.relative(root, full).replace(/\\/g, '/'),
          size_bytes: stat.size,
        });
      }
    }
  };
  walk(dir);
  return results;
}

function validateOutputObject(result: AgentToolResult): AgentToolResult {
  if (typeof result.ok !== 'boolean' || typeof result.summary !== 'string' || typeof result.data !== 'object') {
    return {
      ok: false,
      summary: 'Tool output violated structural contract.',
      data: {},
      error: 'Invalid tool output structure.',
      retryable: false,
    };
  }
  const serialized = JSON.stringify(result.data);
  const secretHit = detectSensitiveSecret(serialized);
  if (secretHit) {
    return {
      ok: false,
      summary: 'Tool output redacted by privacy guard.',
      data: {},
      error: `Tool output blocked: potential ${secretHit} detected.`,
      retryable: false,
    };
  }
  return result;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  constructor() {
    this.registerDefaults();
  }

  register(def: AgentToolDefinition): void {
    this.tools.set(def.id, def);
  }

  get(id: string): AgentToolDefinition | undefined {
    return this.tools.get(id);
  }

  hasOperationalTool(id: string): boolean {
    const def = this.tools.get(id);
    return Boolean(def && def.operational);
  }

  listDescriptors(): PublicToolDescriptor[] {
    return Array.from(this.tools.values()).map(({ execute: _exec, ...pub }) => pub);
  }

  getAllToolIds(): string[] {
    return Array.from(this.tools.keys());
  }

  getOperationalToolIds(): string[] {
    return Array.from(this.tools.values())
      .filter((t) => t.operational)
      .map((t) => t.id);
  }

  async invoke(
    toolId: string,
    input: Record<string, unknown>,
    allowedTools: string[],
    ctx: AgentToolContext
  ): Promise<AgentToolResult> {
    const def = this.tools.get(toolId);
    if (!def) {
      return {
        ok: false,
        summary: `Unknown tool '${toolId}'.`,
        data: {},
        error: `Tool '${toolId}' is not registered in AgentToolRegistry.`,
        retryable: false,
      };
    }
    if (!def.operational) {
      return {
        ok: false,
        summary: `Tool '${toolId}' is a reserved future extension interface and is not operational yet.`,
        data: { operational: false, status: 'interface_reserved' },
        error: `Tool '${toolId}' is not operational in Step 07.`,
        retryable: false,
      };
    }
    if (!allowedTools.includes(toolId)) {
      return {
        ok: false,
        summary: `Tool '${toolId}' denied by agent allowlist.`,
        data: {},
        error: `Permission denied: '${toolId}' is not enabled on agent '${ctx.agentId}'.`,
        retryable: false,
      };
    }

    try {
      const rawResult = await def.execute(input || {}, ctx);
      return validateOutputObject(rawResult);
    } catch (err) {
      return {
        ok: false,
        summary: `Tool '${toolId}' failed during execution.`,
        data: {},
        error: err instanceof Error ? err.message : String(err),
        retryable: def.safe_retryable,
      };
    }
  }

  private registerDefaults(): void {
    // 1. File reading & processing (strictly confined to approved local directories)
    this.register({
      id: 'read_workspace_file',
      name: 'Read & Process Workspace File',
      category: 'file_system',
      description: 'Reads UTF-8 text/code files strictly inside ./data/agent_workspace or ./docs (max 64 KB) and extracts structural metrics.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative path inside data/agent_workspace or docs/' },
          max_preview_chars: { type: 'number', default: 1200 },
        },
      },
      execute: (input, ctx) => {
        const reqPath = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : 'workspace_readme.txt';
        const resolved = resolveSafeWorkspacePath(reqPath, {
          allowDocsFolder: true,
          customRoot: ctx.workspaceRoot,
        });
        if (!resolved.ok) {
          return { ok: false, summary: 'File access denied by sandbox.', data: {}, error: resolved.error, retryable: false };
        }
        if (!fs.existsSync(resolved.resolved)) {
          return {
            ok: false,
            summary: `File not found: ${resolved.displayPath}`,
            data: { path: resolved.displayPath },
            error: `File does not exist at ${resolved.displayPath}.`,
            retryable: false,
          };
        }
        const stat = fs.statSync(resolved.resolved);
        if (!stat.isFile()) {
          return { ok: false, summary: 'Target is not a regular file.', data: {}, error: 'Not a file.', retryable: false };
        }
        if (stat.size > MAX_READ_BYTES) {
          return {
            ok: false,
            summary: 'File exceeds 64 KB sandbox read cap.',
            data: { size_bytes: stat.size },
            error: 'File exceeds 64 KB sandbox read cap.',
            retryable: false,
          };
        }
        const content = fs.readFileSync(resolved.resolved, 'utf8');
        const secretHit = detectSensitiveSecret(content);
        if (secretHit) {
          return {
            ok: false,
            summary: 'File blocked by privacy scanner.',
            data: { path: resolved.displayPath },
            error: `Blocked reading ${resolved.displayPath}: potential ${secretHit} found.`,
            retryable: false,
          };
        }
        const maxPreview = Math.min(2000, Math.max(120, Number(input.max_preview_chars || 1200)));
        const lines = content.split(/\r?\n/);
        const sha256 = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        return {
          ok: true,
          summary: `Read ${resolved.displayPath} (${lines.length} lines, ${stat.size} bytes).`,
          data: {
            path: resolved.displayPath,
            size_bytes: stat.size,
            line_count: lines.length,
            token_estimate: inspectTokensServer(content).token_count,
            sha256_prefix: sha256,
            preview: content.slice(0, maxPreview),
          },
        };
      },
    });

    // 2. Document creation (CONSEQUENTIAL — requires user approval)
    this.register({
      id: 'create_document',
      name: 'Create Workspace Document',
      category: 'document',
      description: 'Creates a markdown/text/json document in ./data/agent_workspace/documents after explicit operator approval.',
      risk_level: 'consequential',
      requires_approval: true,
      safe_retryable: false,
      operational: true,
      input_schema: {
        type: 'object',
        required: ['filename', 'content'],
        properties: {
          filename: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
      execute: (input, ctx) => {
        const rawFilename = typeof input.filename === 'string' ? input.filename : 'agent_output.md';
        const safeName = sanitizeSafeDocFilename(rawFilename);
        const content = typeof input.content === 'string' ? input.content.trim() : '';
        const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : safeName;
        if (!content) {
          return { ok: false, summary: 'Document content cannot be empty.', data: {}, error: 'Empty document content.' };
        }
        if (content.length > MAX_DOC_CHARS) {
          return { ok: false, summary: 'Document exceeds 50,000 character cap.', data: {}, error: 'Document too large.' };
        }
        const secretHit = detectSensitiveSecret(`${title}\n${content}`);
        if (secretHit) {
          return {
            ok: false,
            summary: 'Document creation blocked by secret scanner.',
            data: {},
            error: `Potential ${secretHit} detected; refusing to write document.`,
          };
        }

        const resolved = resolveSafeWorkspacePath(safeName, {
          customRoot: ctx.workspaceRoot,
          requireSubdir: 'documents',
        });
        if (!resolved.ok) {
          return { ok: false, summary: 'Document path rejected.', data: {}, error: resolved.error };
        }
        fs.writeFileSync(resolved.resolved, content, 'utf8');
        return {
          ok: true,
          summary: `Created approved document ${resolved.displayPath} (${Buffer.byteLength(content, 'utf8')} bytes).`,
          data: {
            path: resolved.displayPath,
            filename: safeName,
            title,
            bytes: Buffer.byteLength(content, 'utf8'),
            sha256_prefix: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
          },
        };
      },
    });

    // 3. Restricted code execution (CONSEQUENTIAL — isolated VM, NO shell/fs/network/process)
    this.register({
      id: 'run_restricted_code',
      name: 'Restricted Expression & Script Sandbox',
      category: 'code_execution',
      description: 'Executes pure deterministic JavaScript calculations in an isolated VM (500ms timeout, no fs, no network, no require/process, no shell) after explicit operator approval.',
      risk_level: 'consequential',
      requires_approval: true,
      safe_retryable: false,
      operational: true,
      input_schema: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', description: 'Pure deterministic JS snippet (max 2,500 chars)' },
        },
      },
      execute: (input) => {
        const code = typeof input.code === 'string' ? input.code.trim() : '';
        if (!code) {
          return { ok: false, summary: 'No code supplied.', data: {}, error: 'Code input is required.' };
        }
        if (code.length > MAX_CODE_CHARS) {
          return { ok: false, summary: 'Code exceeds 2,500 character limit.', data: {}, error: 'Code too long.' };
        }
        const forbiddenPattern =
          /\b(require|process|global|globalThis|Buffer|child_process|fs|http|https|fetch|import|eval|Function|WebAssembly|Proxy|Reflect|constructor)\b/i;
        if (forbiddenPattern.test(code)) {
          return {
            ok: false,
            summary: 'Restricted sandbox blocked forbidden identifier.',
            data: {},
            error: 'Code contains forbidden runtime identifier (require, process, fs, fetch, eval, Function, or constructor).',
          };
        }

        const logs: string[] = [];
        const sandbox = Object.create(null) as Record<string, unknown>;
        sandbox.Math = Math;
        sandbox.JSON = JSON;
        sandbox.Number = Number;
        sandbox.String = String;
        sandbox.Boolean = Boolean;
        sandbox.Array = Array;
        sandbox.Object = Object;
        sandbox.console = {
          log: (...args: unknown[]) => {
            if (logs.length < 25) {
              logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 400));
            }
          },
        };
        const context = vm.createContext(sandbox, {
          codeGeneration: { strings: false, wasm: false },
        });
        try {
          const script = new vm.Script(`"use strict";\n${code}`);
          const value = script.runInContext(context, { timeout: 500 });
          let serializedResult = '';
          if (value !== undefined) {
            serializedResult = typeof value === 'string' ? value : JSON.stringify(value);
          }
          return {
            ok: true,
            summary: `Restricted sandbox executed cleanly (${logs.length} log line(s)).`,
            data: {
              stdout: logs,
              result: serializedResult.slice(0, 2000),
              sandbox_mode: 'isolated_vm_no_io',
            },
          };
        } catch (err) {
          return {
            ok: false,
            summary: 'Restricted code execution raised a runtime error.',
            data: { stdout: logs },
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });

    // 4. Knowledge Base retrieval (Step 06 integration)
    this.register({
      id: 'retrieve_knowledge',
      name: 'Knowledge Base Retrieval',
      category: 'knowledge',
      description: 'Searches indexed local Knowledge Base chunks via SQLite FTS5 / LIKE without fabricating missing entries.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          max_chunks: { type: 'number', default: 3 },
        },
      },
      execute: (input, ctx) => {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query) {
          return { ok: false, summary: 'Query cannot be empty.', data: {}, error: 'Query is required.' };
        }
        const retriever = new SqliteKeywordRetriever(ctx.db);
        const result = retriever.retrieve(query, {
          includeMemory: false,
          includeKnowledge: true,
          maxKnowledgeChunks: Math.min(5, Math.max(1, Number(input.max_chunks || 3))),
          contextLength: 8192,
        });
        return {
          ok: true,
          summary: `Found ${result.knowledge.length} matching Knowledge Base chunk(s) (${result.retrieval_backend}).`,
          data: {
            backend: result.retrieval_backend,
            matches: result.knowledge,
            total_context_tokens: result.total_context_tokens,
          },
        };
      },
    });

    // 5. User Memory retrieval (Step 06 integration — strictly approved memories only)
    this.register({
      id: 'retrieve_memory',
      name: 'Approved User Memory Retrieval',
      category: 'memory',
      description: 'Retrieves explicitly user-approved facts, preferences, instructions, and constraints from local SQLite memory.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          max_items: { type: 'number', default: 3 },
        },
      },
      execute: (input, ctx) => {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query) {
          return { ok: false, summary: 'Query cannot be empty.', data: {}, error: 'Query is required.' };
        }
        const retriever = new SqliteKeywordRetriever(ctx.db);
        const result = retriever.retrieve(query, {
          includeMemory: true,
          includeKnowledge: false,
          maxMemoryItems: Math.min(5, Math.max(1, Number(input.max_items || 3))),
          contextLength: 8192,
        });
        return {
          ok: true,
          summary: `Retrieved ${result.memories.length} approved memory entry(ies) (${result.retrieval_backend}).`,
          data: {
            backend: result.retrieval_backend,
            matches: result.memories,
            total_context_tokens: result.total_context_tokens,
          },
        };
      },
    });

    // 6. Local application operations (safe read-only workspace inspection)
    this.register({
      id: 'local_workspace_ops',
      name: 'Local Application Operations',
      category: 'local_app',
      description: 'Inspects workspace health, registered models, memory system status, token counts, and files inside ./data/agent_workspace.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['summary', 'list_workspace_files', 'list_models', 'memory_status', 'tokenize'],
            default: 'summary',
          },
          text: { type: 'string' },
        },
      },
      execute: (input, ctx) => {
        const op = typeof input.operation === 'string' ? input.operation : 'summary';
        const workspaceRoot = getApprovedAgentWorkspaceDir(ctx.workspaceRoot);

        if (op === 'list_workspace_files') {
          const files = listFilesRecursiveBounded(workspaceRoot, workspaceRoot);
          return {
            ok: true,
            summary: `Listed ${files.length} file(s) inside ./data/agent_workspace.`,
            data: { workspace_root: 'data/agent_workspace', files },
          };
        }
        if (op === 'list_models') {
          const models = ctx.db
            .prepare('SELECT id, name, provider, status, loading_status, context_length FROM models ORDER BY created_at ASC')
            .all();
          return {
            ok: true,
            summary: `Enumerated ${models.length} local model manifest(s).`,
            data: { models },
          };
        }
        if (op === 'memory_status') {
          const memCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM memory_entries WHERE approved = 1').get() as { c: number }).c;
          const docCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM knowledge_documents').get() as { c: number }).c;
          const chunkCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM knowledge_chunks').get() as { c: number }).c;
          return {
            ok: true,
            summary: `Memory status: ${memCount} memories, ${docCount} docs, ${chunkCount} chunks.`,
            data: {
              approved_memories: memCount,
              knowledge_documents: docCount,
              knowledge_chunks: chunkCount,
              fts5_enabled: hasFts5Support(ctx.db),
            },
          };
        }
        if (op === 'tokenize') {
          const text = typeof input.text === 'string' ? input.text : '';
          const tok = inspectTokensServer(text);
          return {
            ok: true,
            summary: `Tokenized input into ${tok.token_count} baseline token(s).`,
            data: {
              token_count: tok.token_count,
              char_count: tok.char_count,
              byte_count: tok.byte_count,
              word_count: tok.word_count,
            },
          };
        }

        // Default 'summary'
        const convCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM conversations').get() as { c: number }).c;
        const memCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM memory_entries WHERE approved = 1').get() as { c: number }).c;
        const docCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM knowledge_documents').get() as { c: number }).c;
        const files = listFilesRecursiveBounded(workspaceRoot, workspaceRoot, 20);
        return {
          ok: true,
          summary: `Local workspace healthy (${memCount} memories, ${docCount} KB docs, ${files.length} workspace file(s)).`,
          data: {
            db_path: path.basename(getDbPath()),
            platform: os.platform(),
            total_memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
            free_memory_gb: Number((os.freemem() / 1024 ** 3).toFixed(2)),
            conversations: convCount,
            approved_memories: memCount,
            knowledge_documents: docCount,
            workspace_files: files,
          },
        };
      },
    });

    // Backward-compatible Step 01 read-only diagnostic tool aliases
    this.register({
      id: 'health_check',
      name: 'Workspace Health Check',
      category: 'local_app',
      description: 'Read-only system & SQLite workspace telemetry check.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: { type: 'object', properties: {} },
      execute: (input, ctx) => {
        const delegate = this.tools.get('local_workspace_ops');
        return delegate ? delegate.execute({ ...input, operation: 'summary' }, ctx) : { ok: false, summary: 'Unavailable', data: {} };
      },
    });
    this.register({
      id: 'inspect_tokenizer',
      name: 'Deterministic Tokenizer',
      category: 'local_app',
      description: 'Local deterministic text segmentation & byte count inspection.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: (input, ctx) => {
        const delegate = this.tools.get('local_workspace_ops');
        return delegate ? delegate.execute({ ...input, operation: 'tokenize' }, ctx) : { ok: false, summary: 'Unavailable', data: {} };
      },
    });
    this.register({
      id: 'list_models',
      name: 'Model Registry Reader',
      category: 'local_app',
      description: 'Enumerates locally registered model manifests.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: { type: 'object', properties: {} },
      execute: (input, ctx) => {
        const delegate = this.tools.get('local_workspace_ops');
        return delegate ? delegate.execute({ ...input, operation: 'list_models' }, ctx) : { ok: false, summary: 'Unavailable', data: {} };
      },
    });
    this.register({
      id: 'validate_json_schema',
      name: 'JSON Structural Validator',
      category: 'local_app',
      description: 'Parses JSON payloads safely without code evaluation.',
      risk_level: 'read_only',
      requires_approval: false,
      safe_retryable: true,
      operational: true,
      input_schema: { type: 'object', properties: { json_text: { type: 'string' } } },
      execute: (input) => {
        const raw = typeof input.json_text === 'string' ? input.json_text : '{}';
        try {
          const parsed = JSON.parse(raw);
          return {
            ok: true,
            summary: 'JSON payload parsed cleanly.',
            data: { valid: true, root_type: Array.isArray(parsed) ? 'array' : typeof parsed },
          };
        } catch (err) {
          return {
            ok: false,
            summary: 'Invalid JSON syntax.',
            data: { valid: false },
            error: err instanceof Error ? err.message : 'Invalid JSON.',
          };
        }
      },
    });

    // Future Extension Interfaces (NOT claimed operational)
    this.register({
      id: 'web_search_future',
      name: 'Web Search Adapter (Interface Reserved)',
      category: 'future_extension',
      description: 'Reserved extension interface for Step 08+ Web Search integration. Not operational in Step 07.',
      risk_level: 'reserved_stub',
      requires_approval: true,
      safe_retryable: false,
      operational: false,
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      execute: () => ({
        ok: false,
        summary: 'Reserved future interface (Step 08+).',
        data: { operational: false },
        error: 'Web Search is a reserved interface and is not implemented in Step 07.',
      }),
    });
    this.register({
      id: 'public_data_future',
      name: 'Public Data Sources Adapter (Interface Reserved)',
      category: 'future_extension',
      description: 'Reserved extension interface for verified public datasets. Not operational in Step 07.',
      risk_level: 'reserved_stub',
      requires_approval: true,
      safe_retryable: false,
      operational: false,
      input_schema: { type: 'object', properties: { source: { type: 'string' }, query: { type: 'string' } } },
      execute: () => ({
        ok: false,
        summary: 'Reserved future interface (Step 08+).',
        data: { operational: false },
        error: 'Public Data Sources adapter is a reserved interface and is not implemented in Step 07.',
      }),
    });
    this.register({
      id: 'world_intelligence_future',
      name: 'World Intelligence Interface (Interface Reserved)',
      category: 'future_extension',
      description: 'Reserved extension interface for structured World Intelligence feeds. Not operational in Step 07.',
      risk_level: 'reserved_stub',
      requires_approval: true,
      safe_retryable: false,
      operational: false,
      input_schema: { type: 'object', properties: { topic: { type: 'string' } } },
      execute: () => ({
        ok: false,
        summary: 'Reserved future interface (Step 08+).',
        data: { operational: false },
        error: 'World Intelligence adapter is a reserved interface and is not implemented in Step 07.',
      }),
    });
  }
}

export const defaultToolRegistry = new AgentToolRegistry();
