import type { DatabaseSync } from 'node:sqlite';
import { SqliteKeywordRetriever } from '../ai/memoryRetrieval.ts';
import { AgentToolRegistry, defaultToolRegistry } from './toolRegistry.ts';

export interface PlannedTaskStep {
  step_index: number;
  title: string;
  description: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  requires_approval: boolean;
  safe_retryable: boolean;
}

export interface TaskPlanResult {
  title: string;
  planner_mode: 'deterministic_local';
  memory_context: {
    memories: Array<{ id: string; title: string; category: string }>;
    knowledge: Array<{ document_id: string; document_title: string; chunk_index: number }>;
  };
  steps: PlannedTaskStep[];
}

export interface PlanTaskOptions {
  goal: string;
  title?: string;
  allowedTools: string[];
  maxSteps: number;
  targetFilePath?: string;
  documentFilename?: string;
  codeSnippet?: string;
}

export class AgentTaskPlanner {
  private readonly registry: AgentToolRegistry;

  constructor(registry: AgentToolRegistry = defaultToolRegistry) {
    this.registry = registry;
  }

  planTask(db: DatabaseSync, opts: PlanTaskOptions): TaskPlanResult {
    const goal = opts.goal.trim();
    const lower = goal.toLowerCase();
    const maxSteps = Math.min(12, Math.max(1, opts.maxSteps || 6));
    const allowed = new Set(opts.allowedTools);

    // 1. Gather relevant approved memory & knowledge context for planning
    const retriever = new SqliteKeywordRetriever(db);
    const retrieval = retriever.retrieve(goal, {
      includeMemory: true,
      includeKnowledge: true,
      maxMemoryItems: 3,
      maxKnowledgeChunks: 3,
      contextLength: 8192,
    });

    const steps: PlannedTaskStep[] = [];
    const pushStep = (
      title: string,
      description: string,
      toolName: string,
      toolInput: Record<string, unknown>
    ) => {
      if (steps.length >= maxSteps) return;
      if (!allowed.has(toolName)) return;
      const def = this.registry.get(toolName);
      if (!def || !def.operational) return;
      steps.push({
        step_index: steps.length,
        title,
        description,
        tool_name: toolName,
        tool_input: toolInput,
        requires_approval: def.requires_approval,
        safe_retryable: def.safe_retryable,
      });
    };

    // Always inspect local approved memory first if allowed
    if (allowed.has('retrieve_memory')) {
      pushStep(
        'Retrieve Approved User Memory',
        'Query approved local facts, preferences, and constraints relevant to the task.',
        'retrieve_memory',
        { query: goal, max_items: 3 }
      );
    }

    // Retrieve relevant Knowledge Base chunks if allowed
    if (allowed.has('retrieve_knowledge')) {
      pushStep(
        'Search Local Knowledge Base',
        'Retrieve matching document chunks from local SQLite FTS5 index.',
        'retrieve_knowledge',
        { query: goal, max_chunks: 3 }
      );
    }

    // File reading step if requested or workspace file mentioned
    if (
      allowed.has('read_workspace_file') &&
      (opts.targetFilePath || /\b(file|read|readme|doc|workspace|inspect)\b/.test(lower))
    ) {
      pushStep(
        'Read & Process Workspace File',
        'Inspect approved file content and compute size, line count, and checksum.',
        'read_workspace_file',
        { path: opts.targetFilePath?.trim() || 'workspace_readme.txt', max_preview_chars: 1200 }
      );
    }

    // Restricted code execution step if code snippet provided or calculation/script requested
    if (
      allowed.has('run_restricted_code') &&
      (opts.codeSnippet?.trim() || /\b(calculate|compute|script|code|evaluate|math|expression)\b/.test(lower))
    ) {
      const code =
        opts.codeSnippet?.trim() ||
        `const goalWords = ${JSON.stringify(goal.split(/\s+/).filter(Boolean).length)};\nconsole.log('Analyzed goal word count:', goalWords);\n({ goal_words: goalWords, status: 'evaluated' });`;
      pushStep(
        'Run Restricted Code Sandbox',
        'Execute deterministic calculation in isolated no-IO VM (requires explicit operator approval).',
        'run_restricted_code',
        { code }
      );
    }

    // Local app operations / fallback diagnostic step
    if (allowed.has('local_workspace_ops')) {
      const op = /\b(model|weights)\b/.test(lower)
        ? 'list_models'
        : /\b(files|directory|folder)\b/.test(lower)
          ? 'list_workspace_files'
          : 'summary';
      pushStep(
        'Run Local Workspace Inspection',
        'Gather real-time local workspace status and manifest metrics.',
        'local_workspace_ops',
        { operation: op }
      );
    } else if (allowed.has('health_check')) {
      pushStep(
        'Check Workspace Health',
        'Collect read-only local database and memory telemetry.',
        'health_check',
        {}
      );
    }

    // Document creation step (consequential, gated by approval)
    if (
      allowed.has('create_document') &&
      (opts.documentFilename?.trim() || /\b(document|report|write|create|note|summary|brief|export)\b/.test(lower))
    ) {
      const filename = opts.documentFilename?.trim() || 'task_summary.md';
      const memLine =
        retrieval.memories.length > 0
          ? retrieval.memories.map((m) => `- ${m.title}: ${m.content}`).join('\n')
          : '- No matching approved user memory entries.';
      const kbLine =
        retrieval.knowledge.length > 0
          ? retrieval.knowledge.map((k) => `- ${k.document_title} (chunk #${k.chunk_index}): ${k.content.slice(0, 220)}`).join('\n')
          : '- No matching knowledge base chunks.';
      const docContent = [
        `# ${opts.title?.trim() || 'Genesis Agent Task Report'}`,
        '',
        `**Goal:** ${goal}`,
        '',
        '## Approved User Memory Context',
        memLine,
        '',
        '## Knowledge Base Excerpts',
        kbLine,
      ].join('\n');

      pushStep(
        'Create Workspace Summary Document',
        'Write validated markdown output inside ./data/agent_workspace/documents (requires explicit approval).',
        'create_document',
        {
          filename,
          title: opts.title?.trim() || 'Genesis Agent Task Report',
          content: docContent,
        }
      );
    }

    // Guarantee at least one safe diagnostic step if an agent only has legacy tools like inspect_tokenizer or list_models
    if (steps.length === 0) {
      if (allowed.has('inspect_tokenizer')) {
        pushStep(
          'Inspect Task Tokens',
          'Compute deterministic baseline token count for goal prompt.',
          'inspect_tokenizer',
          { text: goal }
        );
      }
      if (allowed.has('list_models')) {
        pushStep(
          'Enumerate Registered Models',
          'Inspect registered local model adapters.',
          'list_models',
          {}
        );
      }
      if (allowed.has('validate_json_schema')) {
        pushStep(
          'Validate Structured Task Payload',
          'Run structural JSON check on task envelope.',
          'validate_json_schema',
          { json_text: JSON.stringify({ goal }) }
        );
      }
    }

    const derivedTitle =
      opts.title?.trim() ||
      (goal.length > 64 ? `${goal.slice(0, 61).trim()}...` : goal);

    return {
      title: derivedTitle,
      planner_mode: 'deterministic_local',
      memory_context: {
        memories: retrieval.memories.map((m) => ({
          id: m.id,
          title: m.title,
          category: m.category,
        })),
        knowledge: retrieval.knowledge.map((k) => ({
          document_id: k.document_id,
          document_title: k.document_title,
          chunk_index: k.chunk_index,
        })),
      },
      steps,
    };
  }
}

export const defaultTaskPlanner = new AgentTaskPlanner(defaultToolRegistry);
