import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hasFts5Support, runInTransaction } from '../db.ts';
import { detectSensitiveSecret } from '../ai/memoryRetrieval.ts';
import { AgentResultReporter, defaultResultReporter } from './resultReporter.ts';
import { TaskExecutionEngine, defaultTaskExecutor, type TaskExecutionResponse } from './taskExecutor.ts';
import { AgentTaskPlanner, defaultTaskPlanner } from './taskPlanner.ts';
import {
  defaultTaskStateManager,
  TaskStateManager,
  type AgentHistoryRecord,
  type AgentTaskRecord,
  type AgentTaskStepRecord,
} from './taskStateManager.ts';
import { AgentToolRegistry, defaultToolRegistry, type PublicToolDescriptor } from './toolRegistry.ts';

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface AgentTaskDetail extends TaskExecutionResponse {
  history: AgentHistoryRecord[];
}

export class AgentManager {
  private readonly registry: AgentToolRegistry;
  private readonly planner: AgentTaskPlanner;
  private readonly stateManager: TaskStateManager;
  private readonly executor: TaskExecutionEngine;
  private readonly reporter: AgentResultReporter;

  constructor(
    registry: AgentToolRegistry = defaultToolRegistry,
    planner: AgentTaskPlanner = defaultTaskPlanner,
    stateManager: TaskStateManager = defaultTaskStateManager,
    executor: TaskExecutionEngine = defaultTaskExecutor,
    reporter: AgentResultReporter = defaultResultReporter
  ) {
    this.registry = registry;
    this.planner = planner;
    this.stateManager = stateManager;
    this.executor = executor;
    this.reporter = reporter;
  }

  listTools(): PublicToolDescriptor[] {
    return this.registry.listDescriptors();
  }

  getAllowedOperationalToolIds(): string[] {
    return this.registry.getOperationalToolIds();
  }

  async createAndPlanTask(
    db: DatabaseSync,
    params: {
      agentId: string;
      goal: string;
      title?: string;
      targetFilePath?: string;
      documentFilename?: string;
      codeSnippet?: string;
      maxRetries?: number;
      autoRun?: boolean;
      workspaceRoot?: string;
    }
  ): Promise<AgentTaskDetail> {
    const goal = params.goal.trim();
    if (!goal) {
      throw new Error('Task goal cannot be empty.');
    }
    const secretHit = detectSensitiveSecret(`${params.title || ''}\n${goal}\n${params.codeSnippet || ''}`);
    if (secretHit) {
      throw new Error(`Rejected for privacy: potential ${secretHit} detected in task specification.`);
    }

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(params.agentId) as
      | { id: string; name: string; allowed_tools_json: string; sandbox_policy_json: string }
      | undefined;
    if (!agent) {
      throw new Error('Agent blueprint not found.');
    }

    const allowedTools = parseJsonSafe<string[]>(agent.allowed_tools_json, []);
    const policy = parseJsonSafe<{ max_steps?: number }>(agent.sandbox_policy_json, { max_steps: 6 });

    const plan = this.planner.planTask(db, {
      goal,
      title: params.title,
      allowedTools,
      maxSteps: policy.max_steps || 6,
      targetFilePath: params.targetFilePath,
      documentFilename: params.documentFilename,
      codeSnippet: params.codeSnippet,
    });

    const created = this.stateManager.createTask(db, {
      agentId: agent.id,
      title: plan.title,
      goal,
      planSteps: plan.steps,
      memoryContext: plan.memory_context,
      maxRetries: params.maxRetries,
    });

    this.stateManager.recordHistory(db, {
      taskId: created.task.id,
      agentId: agent.id,
      eventType: 'plan_generated',
      detail: `Generated ${plan.steps.length}-step plan (${plan.planner_mode}). Attached ${plan.memory_context.memories.length} memory & ${plan.memory_context.knowledge.length} KB reference(s).`,
    });

    if (params.autoRun) {
      await this.executor.executeTask(db, created.task.id, { workspaceRoot: params.workspaceRoot });
    }

    return this.getTaskDetail(db, created.task.id)!;
  }

  listTasks(db: DatabaseSync, status?: string): Array<AgentTaskRecord & { step_count: number; completed_steps: number; pending_approvals: number }> {
    const tasks = this.stateManager.listTasks(db, status);
    return tasks.map((t) => {
      const steps = this.stateManager.listSteps(db, t.id);
      return {
        ...t,
        step_count: steps.length,
        completed_steps: steps.filter((s) => s.status === 'completed').length,
        pending_approvals: steps.filter((s) => s.status === 'awaiting_approval').length,
      };
    });
  }

  getTaskDetail(db: DatabaseSync, taskId: string): AgentTaskDetail | null {
    const task = this.stateManager.getTask(db, taskId);
    if (!task) return null;
    const steps = this.stateManager.listSteps(db, taskId);
    const history = this.stateManager.listHistory(db, { taskId, limit: 150 });
    return {
      task,
      steps,
      report: this.reporter.buildReport(task, steps),
      history,
    };
  }

  async runTask(
    db: DatabaseSync,
    taskId: string,
    options?: { workspaceRoot?: string }
  ): Promise<AgentTaskDetail> {
    await this.executor.executeTask(db, taskId, options);
    const detail = this.getTaskDetail(db, taskId);
    if (!detail) throw new Error('Agent task not found.');
    return detail;
  }

  async handleStepApproval(
    db: DatabaseSync,
    params: {
      taskId: string;
      stepId: string;
      approved: boolean;
      note?: string;
      resumeExecution?: boolean;
      workspaceRoot?: string;
    }
  ): Promise<AgentTaskDetail> {
    const task = this.stateManager.getTask(db, params.taskId);
    if (!task) throw new Error('Agent task not found.');
    const steps = this.stateManager.listSteps(db, params.taskId);
    const step = steps.find((s) => s.id === params.stepId);
    if (!step) throw new Error('Task step not found.');

    if (params.approved) {
      this.stateManager.updateStepState(db, step.id, {
        status: 'approved',
        approval_status: 'approved',
        approval_note: (params.note || '').trim(),
      });
      this.stateManager.recordHistory(db, {
        taskId: task.id,
        stepId: step.id,
        agentId: task.agent_id,
        eventType: 'approval_granted',
        toolName: step.tool_name,
        detail: `Operator approved step '${step.title}' (${step.tool_name}).`,
      });
      if (params.resumeExecution !== false) {
        await this.executor.executeTask(db, task.id, { workspaceRoot: params.workspaceRoot });
      }
    } else {
      this.stateManager.updateStepState(db, step.id, {
        status: 'rejected',
        approval_status: 'rejected',
        approval_note: (params.note || 'Rejected by operator').trim(),
        error_message: 'Action rejected by operator.',
        completed_at: new Date().toISOString(),
      });
      this.stateManager.updateTaskState(db, task.id, {
        status: 'failed',
        current_step_index: step.step_index,
        error_message: `Step '${step.title}' rejected by operator.`,
        result_summary: `Execution halted: operator rejected consequential action '${step.tool_name}'.`,
      });
      this.stateManager.recordHistory(db, {
        taskId: task.id,
        stepId: step.id,
        agentId: task.agent_id,
        eventType: 'approval_rejected',
        toolName: step.tool_name,
        detail: `Operator rejected step '${step.title}' (${step.tool_name}).`,
      });
    }

    return this.getTaskDetail(db, task.id)!;
  }

  cancelTask(db: DatabaseSync, taskId: string): AgentTaskDetail {
    const task = this.stateManager.getTask(db, taskId);
    if (!task) throw new Error('Agent task not found.');
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return this.getTaskDetail(db, taskId)!;
    }
    this.stateManager.updateTaskState(db, taskId, {
      status: 'cancelled',
      result_summary: 'Task cancelled by operator.',
      completed_at: new Date().toISOString(),
    });
    this.stateManager.recordHistory(db, {
      taskId,
      agentId: task.agent_id,
      eventType: 'task_cancelled',
      detail: `Task '${task.title}' cancelled by operator.`,
    });
    return this.getTaskDetail(db, taskId)!;
  }

  saveTaskResultToMemory(
    db: DatabaseSync,
    params: {
      taskId: string;
      approved: boolean;
      title?: string;
      content?: string;
      category?: string;
      tags?: string[];
    }
  ): { id: string; title: string; category: string; content: string } {
    if (params.approved !== true) {
      throw new Error('Explicit user approval (approved: true) is required before saving agent results to User Memory.');
    }
    const detail = this.getTaskDetail(db, params.taskId);
    if (!detail) {
      throw new Error('Agent task not found.');
    }

    const memTitle = (params.title?.trim() || `Agent Task: ${detail.task.title}`).slice(0, 160);
    const memContent = (params.content?.trim() || detail.report.summary).slice(0, 4000);
    if (!memTitle || !memContent) {
      throw new Error('Memory title and content cannot be empty.');
    }
    const secretHit = detectSensitiveSecret(`${memTitle}\n${memContent}`);
    if (secretHit) {
      throw new Error(`Rejected for privacy: detected potential ${secretHit}.`);
    }

    const validCategories = new Set(['fact', 'preference', 'instruction', 'constraint']);
    const safeCategory = params.category && validCategories.has(params.category) ? params.category : 'fact';
    const safeTags = Array.isArray(params.tags)
      ? params.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : ['agent-result'];

    const id = `mem-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const fts = hasFts5Support(db);

    runInTransaction(db, () => {
      db.prepare(
        `INSERT INTO memory_entries (id, namespace, category, title, content, tags_json, importance, approved, source_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(id, 'project', safeCategory, memTitle, memContent, JSON.stringify(safeTags), 4, null, now, now);

      if (fts) {
        db.prepare(
          'INSERT INTO memory_entries_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)'
        ).run(id, memTitle, memContent, safeTags.join(' '));
      }

      this.stateManager.recordHistory(db, {
        taskId: detail.task.id,
        agentId: detail.task.agent_id,
        eventType: 'memory_saved',
        detail: `Operator approved saving task summary '${memTitle}' into User Memory.`,
        payload: { memory_id: id, category: safeCategory },
      });
    });

    return { id, title: memTitle, category: safeCategory, content: memContent };
  }

  deleteTask(db: DatabaseSync, taskId: string): boolean {
    return this.stateManager.deleteTask(db, taskId);
  }

  listHistory(db: DatabaseSync, options?: { taskId?: string; limit?: number }): AgentHistoryRecord[] {
    return this.stateManager.listHistory(db, options);
  }
}

export const defaultAgentManager = new AgentManager();
