import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from '../db.ts';
import type { PlannedTaskStep } from './taskPlanner.ts';

export type TaskStatus =
  | 'planned'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface AgentTaskStepRecord {
  id: string;
  task_id: string;
  step_index: number;
  title: string;
  description: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: StepStatus;
  requires_approval: boolean;
  approval_status: ApprovalStatus;
  approval_note: string;
  safe_retryable: boolean;
  attempts: number;
  max_attempts: number;
  output: Record<string, unknown>;
  error_message: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AgentTaskRecord {
  id: string;
  agent_id: string;
  agent_name?: string;
  title: string;
  goal: string;
  status: TaskStatus;
  plan: PlannedTaskStep[];
  current_step_index: number;
  memory_context: {
    memories: Array<{ id: string; title: string; category: string }>;
    knowledge: Array<{ document_id: string; document_title: string; chunk_index: number }>;
  };
  result_summary: string;
  error_message: string;
  max_retries: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AgentHistoryRecord {
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

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class TaskStateManager {
  createTask(
    db: DatabaseSync,
    params: {
      agentId: string;
      title: string;
      goal: string;
      planSteps: PlannedTaskStep[];
      memoryContext: AgentTaskRecord['memory_context'];
      maxRetries?: number;
    }
  ): { task: AgentTaskRecord; steps: AgentTaskStepRecord[] } {
    const taskId = `task-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const maxRetries = Math.min(3, Math.max(0, params.maxRetries ?? 1));

    const steps: AgentTaskStepRecord[] = [];
    runInTransaction(db, () => {
      db.prepare(
        `INSERT INTO agent_tasks (
          id, agent_id, title, goal, status, plan_json, current_step_index,
          memory_context_json, result_summary, error_message, max_retries, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        taskId,
        params.agentId,
        params.title,
        params.goal,
        'planned',
        JSON.stringify(params.planSteps),
        0,
        JSON.stringify(params.memoryContext),
        '',
        '',
        maxRetries,
        now,
        now,
        null
      );

      for (const s of params.planSteps) {
        const stepId = `step-${crypto.randomUUID()}`;
        const reqApproval = Boolean(s.requires_approval);
        const approvalStatus: ApprovalStatus = reqApproval ? 'pending' : 'not_required';
        const maxAttempts = s.safe_retryable ? maxRetries + 1 : 1;

        db.prepare(
          `INSERT INTO agent_task_steps (
            id, task_id, step_index, title, description, tool_name, tool_input_json,
            status, requires_approval, approval_status, approval_note, safe_retryable,
            attempts, max_attempts, output_json, error_message, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          stepId,
          taskId,
          s.step_index,
          s.title,
          s.description,
          s.tool_name,
          JSON.stringify(s.tool_input || {}),
          'pending',
          reqApproval ? 1 : 0,
          approvalStatus,
          '',
          s.safe_retryable ? 1 : 0,
          0,
          maxAttempts,
          '{}',
          '',
          null,
          null
        );

        steps.push({
          id: stepId,
          task_id: taskId,
          step_index: s.step_index,
          title: s.title,
          description: s.description,
          tool_name: s.tool_name,
          tool_input: s.tool_input || {},
          status: 'pending',
          requires_approval: reqApproval,
          approval_status: approvalStatus,
          approval_note: '',
          safe_retryable: Boolean(s.safe_retryable),
          attempts: 0,
          max_attempts: maxAttempts,
          output: {},
          error_message: '',
          started_at: null,
          completed_at: null,
        });
      }

      this.recordHistory(db, {
        taskId,
        agentId: params.agentId,
        eventType: 'task_created',
        detail: `Task '${params.title}' planned with ${params.planSteps.length} step(s).`,
        payload: { step_count: params.planSteps.length },
      });
    });

    const task = this.getTask(db, taskId)!;
    return { task, steps };
  }

  getTask(db: DatabaseSync, taskId: string): AgentTaskRecord | null {
    const row = db
      .prepare(
        `SELECT t.*, a.name AS agent_name
         FROM agent_tasks t
         LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTaskRow(row);
  }

  listTasks(db: DatabaseSync, status?: string): AgentTaskRecord[] {
    const rows =
      status && status !== 'all'
        ? (db
            .prepare(
              `SELECT t.*, a.name AS agent_name
               FROM agent_tasks t
               LEFT JOIN agents a ON a.id = t.agent_id
               WHERE t.status = ?
               ORDER BY t.updated_at DESC`
            )
            .all(status) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `SELECT t.*, a.name AS agent_name
               FROM agent_tasks t
               LEFT JOIN agents a ON a.id = t.agent_id
               ORDER BY t.updated_at DESC`
            )
            .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapTaskRow(r));
  }

  listSteps(db: DatabaseSync, taskId: string): AgentTaskStepRecord[] {
    const rows = db
      .prepare('SELECT * FROM agent_task_steps WHERE task_id = ? ORDER BY step_index ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.task_id),
      step_index: Number(r.step_index),
      title: String(r.title),
      description: String(r.description || ''),
      tool_name: String(r.tool_name),
      tool_input: parseJsonSafe<Record<string, unknown>>(String(r.tool_input_json || '{}'), {}),
      status: String(r.status) as StepStatus,
      requires_approval: Boolean(Number(r.requires_approval)),
      approval_status: String(r.approval_status) as ApprovalStatus,
      approval_note: String(r.approval_note || ''),
      safe_retryable: Boolean(Number(r.safe_retryable)),
      attempts: Number(r.attempts || 0),
      max_attempts: Number(r.max_attempts || 1),
      output: parseJsonSafe<Record<string, unknown>>(String(r.output_json || '{}'), {}),
      error_message: String(r.error_message || ''),
      started_at: r.started_at ? String(r.started_at) : null,
      completed_at: r.completed_at ? String(r.completed_at) : null,
    }));
  }

  updateTaskState(
    db: DatabaseSync,
    taskId: string,
    patch: Partial<{
      status: TaskStatus;
      current_step_index: number;
      result_summary: string;
      error_message: string;
      completed_at: string | null;
    }>
  ): void {
    const current = this.getTask(db, taskId);
    if (!current) return;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE agent_tasks
       SET status = ?, current_step_index = ?, result_summary = ?, error_message = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`
    ).run(
      patch.status ?? current.status,
      patch.current_step_index ?? current.current_step_index,
      patch.result_summary ?? current.result_summary,
      patch.error_message ?? current.error_message,
      now,
      patch.completed_at !== undefined ? patch.completed_at : current.completed_at,
      taskId
    );
  }

  updateStepState(
    db: DatabaseSync,
    stepId: string,
    patch: Partial<{
      status: StepStatus;
      approval_status: ApprovalStatus;
      approval_note: string;
      attempts: number;
      output: Record<string, unknown>;
      error_message: string;
      started_at: string | null;
      completed_at: string | null;
    }>
  ): void {
    const row = db.prepare('SELECT * FROM agent_task_steps WHERE id = ?').get(stepId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return;
    db.prepare(
      `UPDATE agent_task_steps
       SET status = ?, approval_status = ?, approval_note = ?, attempts = ?, output_json = ?,
           error_message = ?, started_at = ?, completed_at = ?
       WHERE id = ?`
    ).run(
      patch.status ?? String(row.status),
      patch.approval_status ?? String(row.approval_status),
      patch.approval_note ?? String(row.approval_note || ''),
      patch.attempts ?? Number(row.attempts || 0),
      patch.output !== undefined ? JSON.stringify(patch.output) : String(row.output_json || '{}'),
      patch.error_message ?? String(row.error_message || ''),
      patch.started_at !== undefined ? patch.started_at : (row.started_at as string | null),
      patch.completed_at !== undefined ? patch.completed_at : (row.completed_at as string | null),
      stepId
    );
  }

  recordHistory(
    db: DatabaseSync,
    entry: {
      taskId: string;
      stepId?: string | null;
      agentId: string;
      eventType: string;
      toolName?: string;
      detail: string;
      payload?: Record<string, unknown>;
    }
  ): AgentHistoryRecord {
    const id = `ahist-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const payload = entry.payload || {};
    db.prepare(
      `INSERT INTO agent_execution_history (id, task_id, step_id, agent_id, event_type, tool_name, detail, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      entry.taskId,
      entry.stepId ?? null,
      entry.agentId,
      entry.eventType,
      entry.toolName ?? '',
      entry.detail,
      JSON.stringify(payload),
      now
    );

    return {
      id,
      task_id: entry.taskId,
      step_id: entry.stepId ?? null,
      agent_id: entry.agentId,
      event_type: entry.eventType,
      tool_name: entry.toolName ?? '',
      detail: entry.detail,
      payload,
      created_at: now,
    };
  }

  listHistory(db: DatabaseSync, options?: { taskId?: string; limit?: number }): AgentHistoryRecord[] {
    const limit = Math.min(200, Math.max(1, options?.limit ?? 80));
    const rows = options?.taskId
      ? (db
          .prepare('SELECT * FROM agent_execution_history WHERE task_id = ? ORDER BY created_at ASC LIMIT ?')
          .all(options.taskId, limit) as Array<Record<string, unknown>>)
      : (db
          .prepare('SELECT * FROM agent_execution_history ORDER BY created_at DESC LIMIT ?')
          .all(limit) as Array<Record<string, unknown>>);

    return rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.task_id),
      step_id: r.step_id ? String(r.step_id) : null,
      agent_id: String(r.agent_id),
      event_type: String(r.event_type),
      tool_name: String(r.tool_name || ''),
      detail: String(r.detail || ''),
      payload: parseJsonSafe<Record<string, unknown>>(String(r.payload_json || '{}'), {}),
      created_at: String(r.created_at),
    }));
  }

  deleteTask(db: DatabaseSync, taskId: string): boolean {
    const result = db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(taskId);
    return Number(result.changes) > 0;
  }

  private mapTaskRow(row: Record<string, unknown>): AgentTaskRecord {
    return {
      id: String(row.id),
      agent_id: String(row.agent_id),
      agent_name: row.agent_name ? String(row.agent_name) : undefined,
      title: String(row.title),
      goal: String(row.goal),
      status: String(row.status) as TaskStatus,
      plan: parseJsonSafe<PlannedTaskStep[]>(String(row.plan_json || '[]'), []),
      current_step_index: Number(row.current_step_index || 0),
      memory_context: parseJsonSafe<AgentTaskRecord['memory_context']>(
        String(row.memory_context_json || '{}'),
        { memories: [], knowledge: [] }
      ),
      result_summary: String(row.result_summary || ''),
      error_message: String(row.error_message || ''),
      max_retries: Number(row.max_retries || 1),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      completed_at: row.completed_at ? String(row.completed_at) : null,
    };
  }
}

export const defaultTaskStateManager = new TaskStateManager();
