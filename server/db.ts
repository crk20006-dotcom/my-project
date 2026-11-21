import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dbInstance: DatabaseSync | null = null;
let dbInstancePath: string | null = null;

export function getDbPath(): string {
  const dataDir = path.resolve(process.cwd(), 'data');
  return process.env.GENESIS_DB_PATH
    ? path.resolve(process.cwd(), process.env.GENESIS_DB_PATH)
    : path.join(dataDir, 'genesis.db');
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbInstancePath = null;
  }
}

export function getDb(): DatabaseSync {
  const targetPath = getDbPath();
  if (dbInstance && dbInstancePath === targetPath) {
    return dbInstance;
  }

  if (dbInstance && dbInstancePath !== targetPath) {
    dbInstance.close();
    dbInstance = null;
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  initializeSchema(db);
  seedInitialData(db);

  dbInstance = db;
  dbInstancePath = targetPath;
  return db;
}

export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback error if transaction already closed
    }
    throw err;
  }
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      module TEXT NOT NULL DEFAULT 'chat',
      model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tags_json TEXT NOT NULL DEFAULT '[]',
      sources_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_type TEXT NOT NULL,
      local_path TEXT NOT NULL DEFAULT '',
      endpoint_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'placeholder',
      loading_status TEXT NOT NULL DEFAULT 'unloaded',
      context_length INTEGER NOT NULL DEFAULT 8192,
      quantization TEXT NOT NULL DEFAULT 'Not Configured',
      parameter_count TEXT NOT NULL DEFAULT 'Pending Training',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL,
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      sandbox_policy_json TEXT NOT NULL DEFAULT '{}',
      system_prompt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS laboratory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      schema_json TEXT NOT NULL DEFAULT '{}',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_artifacts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'markdown',
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      workspace_type TEXT NOT NULL DEFAULT 'mixed',
      linked_research_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      kind TEXT NOT NULL,
      format TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, filename),
      FOREIGN KEY (project_id) REFERENCES creator_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS creator_revisions (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES creator_project_files(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES creator_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multimodal_assets (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      extracted_text TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'note',
      source_name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      char_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '[]',
      current_step_index INTEGER NOT NULL DEFAULT 0,
      memory_context_json TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      max_retries INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_task_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL,
      tool_input_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approval_status TEXT NOT NULL DEFAULT 'not_required',
      approval_note TEXT NOT NULL DEFAULT '',
      safe_retryable INTEGER NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      output_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_execution_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages (conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_memory_namespace
      ON memory_entries (namespace);

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc
      ON knowledge_chunks (document_id, chunk_index);

    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status
      ON agent_tasks (status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_agent_task_steps_task
      ON agent_task_steps (task_id, step_index);

    CREATE INDEX IF NOT EXISTS idx_agent_history_task
      ON agent_execution_history (task_id, created_at);

    CREATE TABLE IF NOT EXISTS scientific_experiments (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      discipline TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      established_facts_json TEXT NOT NULL DEFAULT '[]',
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      hypothesis TEXT NOT NULL DEFAULT '',
      experimental_plan TEXT NOT NULL DEFAULT '',
      observations_json TEXT NOT NULL DEFAULT '[]',
      analysis_summary TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'planned',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engineering_calculations (
      id TEXT PRIMARY KEY,
      calculator_type TEXT NOT NULL,
      title TEXT NOT NULL,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      results_json TEXT NOT NULL DEFAULT '{}',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_creator_files_project
      ON creator_project_files (project_id, updated_at);

    CREATE INDEX IF NOT EXISTS idx_creator_revisions_file
      ON creator_revisions (file_id, version);

    CREATE INDEX IF NOT EXISTS idx_memory_updated
      ON memory_entries (updated_at);

    CREATE INDEX IF NOT EXISTS idx_knowledge_updated
      ON knowledge_documents (updated_at);

    CREATE INDEX IF NOT EXISTS idx_research_updated
      ON research_projects (updated_at);

    CREATE INDEX IF NOT EXISTS idx_experiments_updated
      ON scientific_experiments (updated_at);

    CREATE INDEX IF NOT EXISTS idx_engineering_calc_created
      ON engineering_calculations (created_at);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Idempotent Step 06 column migrations for existing memory_entries tables
  const memCols = db.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>;
  const existingMemColNames = new Set(memCols.map((c) => c.name));
  if (!existingMemColNames.has('category')) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'fact';");
  }
  if (!existingMemColNames.has('approved')) {
    db.exec('ALTER TABLE memory_entries ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;');
  }
  if (!existingMemColNames.has('source_conversation_id')) {
    db.exec('ALTER TABLE memory_entries ADD COLUMN source_conversation_id TEXT;');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_approved ON memory_entries (approved, category);');

  // SQLite FTS5 virtual search tables for User Memory and Knowledge Base chunks
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        memory_id UNINDEXED,
        title,
        content,
        tags
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        title,
        content,
        tags
      );
    `);
  } catch {
    // Graceful fallback when running against SQLite compiled without FTS5
  }

  // Record idempotent schema migrations
  const now = new Date().toISOString();
  const insertMigration = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)'
  );
  insertMigration.run('001_core_platform', 'Conversations, messages, memory, research, models, agents, lab, creator, settings, sessions', now);
  insertMigration.run('002_memory_fts5', 'Memory category/approval columns, knowledge base tables, FTS5 indexes', now);
  insertMigration.run('003_agent_creator_multimodal_eng', 'Agent tasks/steps/history, Creator workspaces, Multimodal assets, Scientific & Engineering tables', now);
  insertMigration.run('004_step12_reliability_indexes', 'Schema migration registry and WAL query performance indexes', now);
}

export function hasFts5Support(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts'")
      .get() as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

export function syncMemoryFtsIndexes(db: DatabaseSync): void {
  if (!hasFts5Support(db)) return;
  const ftsMemCount = (db.prepare('SELECT COUNT(*) as c FROM memory_entries_fts').get() as { c: number }).c;
  const rawMemCount = (db.prepare('SELECT COUNT(*) as c FROM memory_entries').get() as { c: number }).c;
  if (ftsMemCount !== rawMemCount) {
    db.exec('DELETE FROM memory_entries_fts;');
    const mems = db
      .prepare('SELECT id, title, content, tags_json FROM memory_entries')
      .all() as Array<{ id: string; title: string; content: string; tags_json: string }>;
    const insertMemFts = db.prepare(
      'INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)'
    );
    for (const m of mems) {
      let tagsText = '';
      try {
        tagsText = (JSON.parse(m.tags_json || '[]') as string[]).join(' ');
      } catch {
        tagsText = '';
      }
      insertMemFts.run(m.id, m.title, m.content, tagsText);
    }
  }

  const ftsChunkCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge_chunks_fts').get() as { c: number }).c;
  const rawChunkCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge_chunks').get() as { c: number }).c;
  if (ftsChunkCount !== rawChunkCount) {
    db.exec('DELETE FROM knowledge_chunks_fts;');
    const chunks = db
      .prepare(
        `SELECT c.id as chunk_id, c.document_id, d.title, c.content, d.tags_json
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id`
      )
      .all() as Array<{
      chunk_id: string;
      document_id: string;
      title: string;
      content: string;
      tags_json: string;
    }>;
    const insertChunkFts = db.prepare(
      'INSERT INTO knowledge_chunks_fts (chunk_id, document_id, title, content, tags) VALUES (?, ?, ?, ?, ?)'
    );
    for (const c of chunks) {
      let tagsText = '';
      try {
        tagsText = (JSON.parse(c.tags_json || '[]') as string[]).join(' ');
      } catch {
        tagsText = '';
      }
      insertChunkFts.run(c.chunk_id, c.document_id, c.title, c.content, tagsText);
    }
  }
}

export function seedInitialData(db: DatabaseSync): void {
  const now = new Date().toISOString();

  const settingsCount = db.prepare('SELECT COUNT(*) as count FROM system_settings').get() as { count: number };
  if (settingsCount.count === 0) {
    const defaultSettings = {
      operator_name: 'Local Operator',
      local_auth_enabled: false,
      passcode_hash: '',
      passcode_salt: '',
      inference_endpoint_url: process.env.GENESIS_INFERENCE_URL || 'http://127.0.0.1:8080',
      prefer_local_inference: false,
      active_model_id: 'genesis-core-placeholder',
      chat_use_memory: true,
      chat_use_knowledge: true,
      inference_temperature: 0.2,
      inference_max_tokens: 512,
      inference_timeout_ms: 30000,
      max_upload_mb: Number(process.env.GENESIS_MAX_UPLOAD_MB || 5),
      allowed_extensions: (
        process.env.GENESIS_ALLOWED_EXTENSIONS ||
        '.txt,.md,.json,.csv,.py,.ts,.tsx,.js,.yaml,.yml,.log,.png,.jpg,.jpeg,.webp,.pdf,.docx,.wav,.mp3,.ogg,.webm,.m4a'
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
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
    db.prepare('INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'core_config',
      JSON.stringify(defaultSettings),
      now
    );
  }

  const modelCount = db.prepare('SELECT COUNT(*) as count FROM models').get() as { count: number };
  if (modelCount.count === 0) {
    const insertModel = db.prepare(`
      INSERT INTO models (
        id, name, provider, model_type, local_path, endpoint_url, status, loading_status,
        context_length, quantization, parameter_count, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertModel.run(
      'genesis-core-placeholder',
      'GENESIS CORE (Placeholder Adapter)',
      'genesis_core',
      'Foundation Transformer (Future In-House Weights)',
      './weights/genesis-core-v0.safetensors',
      '',
      'placeholder',
      'unloaded',
      16384,
      'FP16 / BF16 Target',
      'Pending Pre-training',
      JSON.stringify({
        architecture: 'GenesisDecoderArchitecture',
        weights_verified: false,
        notes: 'Reserved adapter slot for the future independently trained GENESIS CORE foundation model.',
      }),
      now,
      now
    );

    insertModel.run(
      'local-inference-http',
      'Local Inference Server Adapter',
      'local_http',
      'OpenAI-Compatible Local HTTP Endpoint',
      '',
      process.env.GENESIS_INFERENCE_URL || 'http://127.0.0.1:8080',
      'unreachable',
      'unloaded',
      8192,
      'GGUF / Local Server Managed',
      'External Local Process',
      JSON.stringify({
        architecture: 'LocalHttpInferenceAdapter',
        weights_verified: false,
        notes: 'Connects to a locally hosted inference runtime (llama.cpp server, vLLM, or custom Python server) when started on this machine.',
      }),
      now,
      now
    );
  }

  const convCount = db.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number };
  if (convCount.count === 0) {
    const convId = 'conv-genesis-welcome';
    db.prepare(
      'INSERT INTO conversations (id, title, module, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, 'Step 01 Platform Orientation', 'chat', 'genesis-core-placeholder', now, now);

    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'msg-genesis-welcome-1',
      convId,
      'assistant',
      [
        '### Project Genesis — Step 01 Core Platform Active (Demo Mode)',
        '',
        'This workspace is running on a **provider-independent local platform** with persistent SQLite storage. **No external AI API (Gemini, OpenAI, Claude) is connected**, and no foundation model weights are loaded yet.',
        '',
        'What works right now without an AI model:',
        '- **Persistent Conversations & File Validation**: Create threads, attach validated files (`.txt`, `.md`, `.json`, `.py`, `.ts`), copy formatted code blocks, and export records.',
        '- **Local Inference Probe**: If you start a local inference server on `127.0.0.1:8080` and enable it in **System Settings**, Genesis can dispatch requests to your local endpoint.',
        '- **Architecture, Memory, Research, Laboratory, Creator & Security**: All 10 modules read and persist real records in the local SQLite database.',
        '',
        'Send any message below to inspect how Demo Mode handles prompt packaging, deterministic token estimation, and attachment diagnostics.',
      ].join('\n'),
      '[]',
      JSON.stringify({ mode: 'demo', model_name: 'DEMO MODE (No Model Connected)', diagnostic: true }),
      now
    );
  }

  const memCount = db.prepare('SELECT COUNT(*) as count FROM memory_entries').get() as { count: number };
  if (memCount.count === 0) {
    const insertMem = db.prepare(
      'INSERT INTO memory_entries (id, namespace, title, content, tags_json, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertMem.run(
      'mem-arch-principle',
      'semantic',
      'Provider-Independent AI Boundary',
      'All model calls must route through BaseInferenceEngine and BaseModelAdapter so GENESIS CORE weights can be integrated in later development steps without rewriting UI or database layers.',
      JSON.stringify(['architecture', 'genesis-core', 'step-01']),
      5,
      now,
      now
    );
    insertMem.run(
      'mem-security-sandbox',
      'procedural',
      'Sandboxed Tool Execution Policy',
      'Agents default to strict allowlist execution: network egress disabled, filesystem writes restricted to workspace scope, and arbitrary shell execution blocked.',
      JSON.stringify(['security', 'sandbox', 'agents']),
      5,
      now,
      now
    );
  }

  const researchCount = db.prepare('SELECT COUNT(*) as count FROM research_projects').get() as { count: number };
  if (researchCount.count === 0) {
    db.prepare(
      'INSERT INTO research_projects (id, title, summary, status, tags_json, sources_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'res-tokenizer-study',
      'GENESIS CORE Tokenizer & Context Budget Specification',
      'Architectural study comparing byte-level BPE vs. unigram subword vocabularies for technical code, mathematics, and multilingual prose.',
      'active',
      JSON.stringify(['tokenizer', 'pretraining', 'step-02-prep']),
      JSON.stringify([
        {
          id: 'src-1',
          title: 'Internal Spec: Byte-Fallback BPE',
          reference: 'docs/ARCHITECTURE.md#tokenizer',
          note: 'Target vocabulary size: 65,536 tokens with reserved special control tokens.',
        },
      ]),
      'Step 01 provides the deterministic baseline tokenizer in Genesis Laboratory so context length calculations and byte inspection can be tested prior to vocabulary training.',
      now,
      now
    );
  }

  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
  const insertAgent = db.prepare(
    'INSERT OR IGNORE INTO agents (id, name, role, description, allowed_tools_json, sandbox_policy_json, system_prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  if (agentCount.count === 0) {
    insertAgent.run(
      'agent-workspace-auditor',
      'Workspace Diagnostics Agent',
      'System & Configuration Inspector',
      'Inspects local database health, validates JSON schemas, and enumerates registered model manifests under strict read-only sandbox constraints.',
      JSON.stringify(['health_check', 'inspect_tokenizer', 'validate_json_schema', 'list_models']),
      JSON.stringify({
        allow_network: false,
        allow_filesystem_write: false,
        allow_shell_execution: false,
        max_steps: 4,
        workspace_scope: './data/agent_workspace',
      }),
      'Operate strictly within read-only workspace tools. Never request external network access or arbitrary shell execution.',
      'ready',
      now,
      now
    );
  }
  const hasTaskOperator = db.prepare("SELECT 1 FROM agents WHERE id = 'agent-task-operator'").get();
  const hasAnyTasks = (db.prepare('SELECT COUNT(*) as count FROM agent_tasks').get() as { count: number }).count > 0;
  if (!hasTaskOperator && (agentCount.count === 0 || !hasAnyTasks)) {
    insertAgent.run(
      'agent-task-operator',
      'Genesis Task Operator',
      'Local Memory, File & Document Orchestrator',
      'Breaks goals into sequential plans using approved Memory, Knowledge Base retrieval, safe workspace file processing, approval-gated document creation, and restricted expression evaluation.',
      JSON.stringify([
        'retrieve_memory',
        'retrieve_knowledge',
        'read_workspace_file',
        'create_document',
        'run_restricted_code',
        'local_workspace_ops',
      ]),
      JSON.stringify({
        allow_network: false,
        allow_filesystem_write: true,
        allow_shell_execution: false,
        max_steps: 6,
        workspace_scope: './data/agent_workspace',
      }),
      'Plan carefully, check User Memory and Knowledge Base first, and request explicit operator approval before writing documents or executing restricted code.',
      'ready',
      now,
      now
    );
  }

  // Ensure safe agent workspace folder exists with an orientation file for file-reading tools
  const agentWorkspaceDir = path.resolve(process.cwd(), 'data', 'agent_workspace');
  const agentDocsDir = path.join(agentWorkspaceDir, 'documents');
  if (!fs.existsSync(agentDocsDir)) {
    fs.mkdirSync(agentDocsDir, { recursive: true });
  }
  const readmePath = path.join(agentWorkspaceDir, 'workspace_readme.txt');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(
      readmePath,
      [
        'Project Genesis — Approved Agent Workspace',
        'Scope: ./data/agent_workspace',
        'Policy: Read/write operations are strictly confined to approved local workspace folders.',
        'External network egress and arbitrary shell commands remain disabled.',
      ].join('\n'),
      'utf8'
    );
  }

  const labCount = db.prepare('SELECT COUNT(*) as count FROM laboratory_items').get() as { count: number };
  if (labCount.count === 0) {
    db.prepare(
      'INSERT INTO laboratory_items (id, kind, name, content, schema_json, metrics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'lab-prompt-blueprint',
      'prompt_template',
      'Genesis Structured Reasoning Template',
      'System: {{system_role}}\nContext Budget: {{max_tokens}} tokens\nMemory Namespace: {{namespace}}\n\nTask:\n{{user_input}}',
      JSON.stringify({
        type: 'object',
        required: ['system_role', 'max_tokens', 'namespace', 'user_input'],
        properties: {
          system_role: { type: 'string' },
          max_tokens: { type: 'number' },
          namespace: { type: 'string' },
          user_input: { type: 'string' },
        },
      }),
      JSON.stringify({ template_variables: 4, validated: true }),
      now,
      now
    );
  }

  const creatorCount = db.prepare('SELECT COUNT(*) as count FROM creator_artifacts').get() as { count: number };
  if (creatorCount.count === 0) {
    db.prepare(
      'INSERT INTO creator_artifacts (id, title, artifact_type, language, content, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'art-genesis-adapter-spec',
      'GENESIS CORE Adapter Integration Contract',
      'code',
      'python',
      `from app.ai.interfaces import BaseModelAdapter, InferenceRequest, InferenceResponse

class GenesisCoreAdapter(BaseModelAdapter):
    """Future Step 02 adapter for locally trained GENESIS CORE weights."""
    model_id = "genesis-core-v1"

    async def load_weights(self, local_path: str) -> bool:
        # Load local .safetensors or .gguf tensor checkpoint here
        raise NotImplementedError("Weights not yet trained in Step 01")

    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        raise NotImplementedError("Inference runtime awaiting Step 02 model checkpoint")`,
      1,
      now,
      now
    );
  }
  const creatorProjCount = db.prepare('SELECT COUNT(*) as count FROM creator_projects').get() as {
    count: number;
  };
  if (creatorProjCount.count === 0) {
    const starterProjId = 'proj-genesis-studio';
    db.prepare(
      'INSERT INTO creator_projects (id, name, description, workspace_type, linked_research_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      starterProjId,
      'Genesis Core Starter Workspace',
      'Sample multi-format Creator Studio project containing Python module code, a structured technical specification document, and an architecture presentation deck.',
      'mixed',
      'res-tokenizer-study',
      JSON.stringify({ step: 'Step 09' }),
      now,
      now
    );

    const insertFile = db.prepare(
      'INSERT INTO creator_project_files (id, project_id, filename, kind, format, content, metadata_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertRev = db.prepare(
      'INSERT INTO creator_revisions (id, file_id, project_id, version, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    const sampleCode = `"""Genesis Core Baseline Token Counter."""\nfrom typing import List\n\n\ndef estimate_tokens(text: str) -> List[str]:\n    if not text:\n        return []\n    return [seg for seg in text.strip().split() if seg]\n\n\nif __name__ == "__main__":\n    sample = "Project Genesis local creator workspace"\n    tokens = estimate_tokens(sample)\n    print(f"Estimated tokens: {len(tokens)}")\n`;
    const sampleDoc = `# Project Genesis — Creator Studio Specification\n\n## Overview\n\nGenesis Creator Studio unifies local coding, structured technical document authoring, and presentation design on top of the local SQLite persistence layer.\n\n## Core Capabilities\n\n- **Coding Studio**: Static diagnostics, explanation, refactoring, and syntax highlighting for Python, JavaScript, TypeScript, HTML, CSS, C, and C++.\n- **Document Creator**: Structured export to Word (.docx), PDF (.pdf), Markdown (.md), and Text (.txt).\n- **Presentation Creator**: Theme-aware slide layouts, diagrams, and native PowerPoint (.pptx) export.\n\n## Architecture Summary\n\n| Layer | Component | Responsibility |\n| --- | --- | --- |\n| Persistence | SQLite WAL | Projects, files, and revision history |\n| Intelligence | Local Adapter | Optional loopback LLM or Demo diagnostics |\n| Security | Path & Sandbox | Workspace confinement and approval gating |\n`;
    const sampleDeck = JSON.stringify(
      {
        title: 'Project Genesis — Architecture Overview',
        subtitle: 'Independent Local AI Operating System · Step 09 Creator Studio',
        author: 'Local Operator',
        theme: 'genesis_dark',
        slides: [
          {
            id: 'slide-1',
            layout: 'title',
            title: 'Project Genesis',
            subtitle: 'Independent AI Operating System · Creator Studio Overview',
            bullets: ['Local-First Architecture', 'No External AI API Dependencies'],
            notes: 'Introduction slide for the Genesis Core architecture deck.',
          },
          {
            id: 'slide-2',
            layout: 'title_content',
            title: 'Modular Workstation Capabilities',
            subtitle: 'Steps 01–09 Integrated',
            bullets: [
              'Local SQLite persistence with FTS5 Memory & Knowledge retrieval',
              'Sandboxed Agent Operating System with explicit operator approvals',
              'Creator Studio: Multi-language Coding, DOCX/PDF Documents, and PPTX Decks',
            ],
            notes: 'Covers core modules built across Steps 01 through 09.',
          },
          {
            id: 'slide-3',
            layout: 'diagram',
            title: 'Provider-Independent Inference Flow',
            subtitle: 'Zero Vendor Lock-In',
            bullets: ['Prompt context is assembled locally before adapter dispatch.'],
            diagram: {
              kind: 'flow',
              nodes: [
                { id: 'n1', label: 'Creator Studio', role: 'Workspace' },
                { id: 'n2', label: 'Memory & KB', role: 'FTS5 Context' },
                { id: 'n3', label: 'Model Adapter', role: 'Local / Demo' },
                { id: 'n4', label: 'Export Engine', role: 'DOCX / PDF / PPTX' },
              ],
              edges: [
                { from: 'n1', to: 'n2', label: 'Retrieve' },
                { from: 'n2', to: 'n3', label: 'Prompt' },
                { from: 'n3', to: 'n4', label: 'Output' },
              ],
            },
            notes: 'Shows how Creator Studio connects with Memory and Model Adapters.',
          },
        ],
      },
      null,
      2
    );

    insertFile.run(
      'cfile-starter-py',
      starterProjId,
      'token_counter.py',
      'code',
      'python',
      sampleCode,
      JSON.stringify({ language: 'python' }),
      1,
      now,
      now
    );
    insertRev.run('crev-starter-py-1', 'cfile-starter-py', starterProjId, 1, 'Initial starter file', sampleCode, now);

    insertFile.run(
      'cfile-starter-doc',
      starterProjId,
      'creator_spec.md',
      'document',
      'markdown',
      sampleDoc,
      JSON.stringify({ author: 'Local Operator' }),
      1,
      now,
      now
    );
    insertRev.run('crev-starter-doc-1', 'cfile-starter-doc', starterProjId, 1, 'Initial starter document', sampleDoc, now);

    insertFile.run(
      'cfile-starter-deck',
      starterProjId,
      'genesis_overview.pptx.json',
      'presentation',
      'pptx',
      sampleDeck,
      JSON.stringify({ theme: 'genesis_dark' }),
      1,
      now,
      now
    );
    insertRev.run('crev-starter-deck-1', 'cfile-starter-deck', starterProjId, 1, 'Initial starter presentation', sampleDeck, now);
  }
  syncMemoryFtsIndexes(db);
}

export function resetWorkspaceData(db: DatabaseSync): void {
  runInTransaction(db, () => {
    db.exec(`
      DELETE FROM agent_execution_history;
      DELETE FROM agent_task_steps;
      DELETE FROM agent_tasks;
      DELETE FROM messages;
      DELETE FROM conversations;
      DELETE FROM memory_entries;
      DELETE FROM knowledge_chunks;
      DELETE FROM knowledge_documents;
      DELETE FROM research_projects;
      DELETE FROM models;
      DELETE FROM agents;
      DELETE FROM laboratory_items;
      DELETE FROM creator_revisions;
      DELETE FROM creator_project_files;
      DELETE FROM creator_projects;
      DELETE FROM creator_artifacts;
      DELETE FROM multimodal_assets;
      DELETE FROM scientific_experiments;
      DELETE FROM engineering_calculations;
    `);
    if (hasFts5Support(db)) {
      db.exec('DELETE FROM memory_entries_fts; DELETE FROM knowledge_chunks_fts;');
    }
    seedInitialData(db);
  });
}

export function hashPasscode(passcode: string, salt?: string): { hash: string; salt: string } {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(passcode, actualSalt, 100000, 32, 'sha256').toString('hex');
  return { hash: derived, salt: actualSalt };
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DatabaseSync, ttlSeconds = 8 * 60 * 60): { token: string; expires_at: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  // Prune expired sessions opportunistically
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)').run(
    tokenHash,
    expiresAt,
    now.toISOString()
  );

  return { token, expires_at: expiresAt };
}

export function verifySessionToken(db: DatabaseSync, token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string' || token.length < 32) {
    return false;
  }
  const tokenHash = hashSessionToken(token);
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
    | { expires_at: string }
    | undefined;
  if (!row) {
    return false;
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return false;
  }
  return true;
}

export function revokeSessionToken(db: DatabaseSync, token: string | null | undefined): void {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function clearAllSessions(db: DatabaseSync): void {
  db.exec('DELETE FROM sessions;');
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

const BACKUP_TABLES = [
  'conversations',
  'messages',
  'memory_entries',
  'knowledge_documents',
  'knowledge_chunks',
  'research_projects',
  'models',
  'agents',
  'agent_tasks',
  'agent_task_steps',
  'agent_execution_history',
  'laboratory_items',
  'creator_artifacts',
  'creator_projects',
  'creator_project_files',
  'creator_revisions',
  'multimodal_assets',
  'scientific_experiments',
  'engineering_calculations',
] as const;

export function runDatabaseIntegrityCheck(db: DatabaseSync): DatabaseIntegrityReport {
  const integrityRows = db.prepare('PRAGMA integrity_check(10);').all() as Array<{
    integrity_check?: string;
  }>;
  const integrityMessages = integrityRows
    .map((r) => String(r.integrity_check || Object.values(r)[0] || ''))
    .filter(Boolean);

  const fkRows = db.prepare('PRAGMA foreign_key_check;').all();
  const journalRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string } | undefined;

  const dbPath = getDbPath();
  let dbSizeBytes = 0;
  try {
    if (fs.existsSync(dbPath)) {
      dbSizeBytes = fs.statSync(dbPath).size;
    }
  } catch {
    dbSizeBytes = 0;
  }

  const tableCounts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      tableCounts[table] = Number(row?.c ?? 0);
    } catch {
      tableCounts[table] = 0;
    }
  }

  const migrations = db
    .prepare('SELECT version, description, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: string; description: string; applied_at: string }>;

  const ok =
    integrityMessages.length === 1 &&
    integrityMessages[0].toLowerCase() === 'ok' &&
    fkRows.length === 0;

  return {
    ok,
    integrity_check: integrityMessages,
    foreign_key_violations: fkRows.length,
    journal_mode: String(journalRow?.journal_mode || 'wal'),
    db_path: dbPath,
    db_size_bytes: dbSizeBytes,
    fts5_enabled: hasFts5Support(db),
    migrations_applied: migrations,
    table_counts: tableCounts,
    checked_at: new Date().toISOString(),
  };
}

export function createBinaryBackupTempFile(db: DatabaseSync): { tempPath: string; sizeBytes: number } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-backup-'));
  const tempPath = path.join(tempDir, `genesis_backup_${Date.now()}.db`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const escaped = tempPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  const stat = fs.statSync(tempPath);
  return { tempPath, sizeBytes: stat.size };
}

export function restoreDatabaseSnapshot(
  db: DatabaseSync,
  snapshot: Record<string, unknown>
): { restored_tables: Record<string, number>; restored_at: string } {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Invalid backup payload: expected JSON object.');
  }

  const hasAnyTable = BACKUP_TABLES.some((t) => Array.isArray(snapshot[t]));
  if (!hasAnyTable) {
    throw new Error('Backup JSON does not contain any recognized Project Genesis database tables.');
  }

  const restoredCounts: Record<string, number> = {};

  runInTransaction(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON;');
    // Delete in child-to-parent order cleanly
    for (const table of [...BACKUP_TABLES].reverse()) {
      db.exec(`DELETE FROM ${table};`);
    }
    if (hasFts5Support(db)) {
      db.exec('DELETE FROM memory_entries_fts; DELETE FROM knowledge_chunks_fts;');
    }

    for (const table of BACKUP_TABLES) {
      const rows = Array.isArray(snapshot[table]) ? (snapshot[table] as Array<Record<string, unknown>>) : [];
      const colInfo = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const validCols = colInfo.map((c) => c.name);
      if (validCols.length === 0) {
        restoredCounts[table] = 0;
        continue;
      }

      const placeholders = validCols.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT INTO ${table} (${validCols.join(', ')}) VALUES (${placeholders})`);
      let inserted = 0;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const values = validCols.map((col) => {
          const val = row[col];
          if (val === undefined) return null;
          if (typeof val === 'boolean') return val ? 1 : 0;
          if (val !== null && typeof val === 'object') return JSON.stringify(val);
          return val as string | number | null;
        });
        stmt.run(...values);
        inserted += 1;
      }
      restoredCounts[table] = inserted;
    }

    // Restore non-secret configuration fields safely if present in backup
    if (snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings)) {
      const incoming = snapshot.settings as Record<string, unknown>;
      const existingRow = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get('core_config') as
        | { value_json: string }
        | undefined;
      const currentCfg = existingRow ? (JSON.parse(existingRow.value_json) as Record<string, unknown>) : {};
      const safeKeys = [
        'operator_name',
        'inference_endpoint_url',
        'prefer_local_inference',
        'active_model_id',
        'chat_use_memory',
        'chat_use_knowledge',
        'inference_temperature',
        'inference_max_tokens',
        'inference_timeout_ms',
        'max_upload_mb',
        'allowed_extensions',
        'sandbox_strict_mode',
        'voice_sample_rate',
        'voice_vad_threshold',
        'voice_stt_adapter',
        'voice_tts_adapter',
        'voice_stt_language',
        'voice_tts_voice',
        'voice_tts_rate',
        'voice_auto_speak',
        'voice_stt_endpoint_url',
        'voice_tts_endpoint_url',
        'vision_endpoint_url',
        'ocr_enabled',
        'first_run_completed',
      ];
      for (const key of safeKeys) {
        if (incoming[key] !== undefined) {
          currentCfg[key] = incoming[key];
        }
      }
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
        'core_config',
        JSON.stringify(currentCfg),
        new Date().toISOString()
      );
    }

    syncMemoryFtsIndexes(db);
  });

  return {
    restored_tables: restoredCounts,
    restored_at: new Date().toISOString(),
  };
}
