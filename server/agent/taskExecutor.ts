import type { DatabaseSync } from 'node:sqlite';
import { AgentResultReporter, defaultResultReporter, type AgentResultReport } from './resultReporter.ts';
import {
  defaultTaskStateManager,
  TaskStateManager,
  type AgentTaskRecord,
  type AgentTaskStepRecord,
} from './taskStateManager.ts';
import { AgentToolRegistry, defaultToolRegistry } from './toolRegistry.ts';

export interface TaskExecutionResponse {
  task: AgentTaskRecord;
  steps: AgentTaskStepRecord[];
  report: AgentResultReport;
}

export class TaskExecutionEngine {
  private readonly registry: AgentToolRegistry;
  private readonly stateManager: TaskStateManager;
  private readonly reporter: AgentResultReporter;

  constructor(
    registry: AgentToolRegistry = defaultToolRegistry,
    stateManager: TaskStateManager = defaultTaskStateManager,
    reporter: AgentResultReporter = defaultResultReporter
  ) {
    this.registry = registry;
    this.stateManager = stateManager;
    this.reporter = reporter;
  }

  async executeTask(
    db: DatabaseSync,
    taskId: string,
    options?: { workspaceRoot?: string }
  ): Promise<TaskExecutionResponse> {
    const task = this.stateManager.getTask(db, taskId);
    if (!task) {
      throw new Error('Agent task not found.');
    }
    if (task.status === 'cancelled') {
      const steps = this.stateManager.listSteps(db, taskId);
      return { task, steps, report: this.reporter.buildReport(task, steps) };
    }
    if (task.status === 'completed') {
      const steps = this.stateManager.listSteps(db, taskId);
      return { task, steps, report: this.reporter.buildReport(task, steps) };
    }

    const agentRow = db.prepare('SELECT * FROM agents WHERE id = ?').get(task.agent_id) as
      | { id: string; allowed_tools_json: string; sandbox_policy_json: string }
      | undefined;
    if (!agentRow) {
      throw new Error('Assigned agent blueprint not found.');
    }

    let allowedTools: string[] = [];
    try {
      allowedTools = JSON.parse(agentRow.allowed_tools_json || '[]') as string[];
    } catch {
      allowedTools = [];
    }

    let steps = this.stateManager.listSteps(db, taskId);
    if (steps.length === 0) {
      const completedAt = new Date().toISOString();
      this.stateManager.updateTaskState(db, taskId, {
        status: 'completed',
        result_summary: 'Task had zero planned steps.',
        completed_at: completedAt,
      });
      const updated = this.stateManager.getTask(db, taskId)!;
      return { task: updated, steps, report: this.reporter.buildReport(updated, steps) };
    }

    this.stateManager.updateTaskState(db, taskId, {
      status: 'running',
      error_message: '',
    });

    for (const step of steps) {
      if (step.status === 'completed' || step.status === 'skipped') {
        continue;
      }
      if (step.status === 'rejected' || step.approval_status === 'rejected') {
        this.stateManager.updateTaskState(db, taskId, {
          status: 'failed',
          current_step_index: step.step_index,
          error_message: `Step '${step.title}' was rejected by the operator.`,
          result_summary: `Execution halted: operator rejected '${step.title}'.`,
        });
        steps = this.stateManager.listSteps(db, taskId);
        const failedTask = this.stateManager.getTask(db, taskId)!;
        return { task: failedTask, steps, report: this.reporter.buildReport(failedTask, steps) };
      }

      // Enforce explicit approval gate before consequential tools execute
      const toolDef = this.registry.get(step.tool_name);
      const needsApproval = step.requires_approval || Boolean(toolDef?.requires_approval);
      if (needsApproval && step.approval_status !== 'approved') {
        this.stateManager.updateStepState(db, step.id, {
          status: 'awaiting_approval',
          approval_status: 'pending',
        });
        this.stateManager.updateTaskState(db, taskId, {
          status: 'awaiting_approval',
          current_step_index: step.step_index,
          result_summary: `Awaiting explicit operator approval for step ${step.step_index + 1}: ${step.title} (${step.tool_name}).`,
        });
        this.stateManager.recordHistory(db, {
          taskId,
          stepId: step.id,
          agentId: task.agent_id,
          eventType: 'approval_requested',
          toolName: step.tool_name,
          detail: `Approval required before running '${step.tool_name}' on step '${step.title}'.`,
          payload: { step_index: step.step_index, tool_input: step.tool_input },
        });
        steps = this.stateManager.listSteps(db, taskId);
        const pausedTask = this.stateManager.getTask(db, taskId)!;
        return { task: pausedTask, steps, report: this.reporter.buildReport(pausedTask, steps) };
      }

      // Execute step sequentially with safe retry handling for idempotent operations
      const startedAt = new Date().toISOString();
      this.stateManager.updateTaskState(db, taskId, {
        status: 'running',
        current_step_index: step.step_index,
      });
      this.stateManager.updateStepState(db, step.id, {
        status: 'running',
        started_at: step.started_at || startedAt,
      });
      this.stateManager.recordHistory(db, {
        taskId,
        stepId: step.id,
        agentId: task.agent_id,
        eventType: 'step_started',
        toolName: step.tool_name,
        detail: `Executing step ${step.step_index + 1}: ${step.title}.`,
      });

      let attempt = step.attempts;
      const maxAttempts = Math.max(1, step.max_attempts || 1);
      let finalResult: Awaited<ReturnType<AgentToolRegistry['invoke']>> | null = null;

      while (attempt < maxAttempts) {
        attempt += 1;
        const result = await this.registry.invoke(step.tool_name, step.tool_input, allowedTools, {
          db,
          agentId: task.agent_id,
          taskId,
          workspaceRoot: options?.workspaceRoot,
        });
        finalResult = result;

        if (result.ok) {
          break;
        }
        const canRetry = step.safe_retryable && Boolean(result.retryable) && attempt < maxAttempts;
        if (canRetry) {
          this.stateManager.recordHistory(db, {
            taskId,
            stepId: step.id,
            agentId: task.agent_id,
            eventType: 'step_retried',
            toolName: step.tool_name,
            detail: `Retrying safe step '${step.title}' (attempt ${attempt + 1}/${maxAttempts}): ${result.error || result.summary}`,
          });
          continue;
        }
        break;
      }

      const doneAt = new Date().toISOString();
      if (finalResult && finalResult.ok) {
        this.stateManager.updateStepState(db, step.id, {
          status: 'completed',
          attempts: attempt,
          output: { summary: finalResult.summary, data: finalResult.data },
          error_message: '',
          completed_at: doneAt,
        });
        this.stateManager.recordHistory(db, {
          taskId,
          stepId: step.id,
          agentId: task.agent_id,
          eventType: 'tool_executed',
          toolName: step.tool_name,
          detail: finalResult.summary,
          payload: { attempts: attempt, data: finalResult.data },
        });
      } else {
        const errMsg = finalResult?.error || finalResult?.summary || 'Unknown tool execution error.';
        this.stateManager.updateStepState(db, step.id, {
          status: 'failed',
          attempts: attempt,
          output: finalResult ? { summary: finalResult.summary, data: finalResult.data } : {},
          error_message: errMsg,
          completed_at: doneAt,
        });
        this.stateManager.recordHistory(db, {
          taskId,
          stepId: step.id,
          agentId: task.agent_id,
          eventType: 'step_failed',
          toolName: step.tool_name,
          detail: errMsg,
          payload: { attempts: attempt },
        });
        this.stateManager.updateTaskState(db, taskId, {
          status: 'failed',
          current_step_index: step.step_index,
          error_message: errMsg,
          result_summary: `Failed at step ${step.step_index + 1} (${step.title}): ${errMsg}`,
        });
        this.stateManager.recordHistory(db, {
          taskId,
          stepId: step.id,
          agentId: task.agent_id,
          eventType: 'task_failed',
          toolName: step.tool_name,
          detail: `Task failed at step ${step.step_index + 1}: ${errMsg}`,
        });
        steps = this.stateManager.listSteps(db, taskId);
        const failedTask = this.stateManager.getTask(db, taskId)!;
        return { task: failedTask, steps, report: this.reporter.buildReport(failedTask, steps) };
      }
    }

    steps = this.stateManager.listSteps(db, taskId);
    const completedAt = new Date().toISOString();
    const provisionalReport = this.reporter.buildReport(
      { ...task, status: 'completed', completed_at: completedAt, result_summary: '' },
      steps
    );
    this.stateManager.updateTaskState(db, taskId, {
      status: 'completed',
      current_step_index: Math.max(0, steps.length - 1),
      result_summary: provisionalReport.summary,
      error_message: '',
      completed_at: completedAt,
    });
    this.stateManager.recordHistory(db, {
      taskId,
      agentId: task.agent_id,
      eventType: 'task_completed',
      detail: provisionalReport.summary,
      payload: {
        completed_steps: provisionalReport.completed_steps,
        artifacts_created: provisionalReport.artifacts_created,
      },
    });

    const completedTask = this.stateManager.getTask(db, taskId)!;
    return {
      task: completedTask,
      steps,
      report: this.reporter.buildReport(completedTask, steps),
    };
  }
}

export const defaultTaskExecutor = new TaskExecutionEngine(
  defaultToolRegistry,
  defaultTaskStateManager,
  defaultResultReporter
);
