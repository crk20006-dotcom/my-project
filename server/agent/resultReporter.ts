import type { AgentTaskRecord, AgentTaskStepRecord } from './taskStateManager.ts';

export interface AgentResultReport {
  task_id: string;
  title: string;
  status: AgentTaskRecord['status'];
  completed_steps: number;
  total_steps: number;
  failed_steps: number;
  pending_approvals: number;
  summary: string;
  artifacts_created: Array<{ path: string; bytes: number }>;
  step_outcomes: Array<{
    step_index: number;
    title: string;
    tool_name: string;
    status: string;
    summary: string;
    error?: string;
  }>;
}

export class AgentResultReporter {
  buildReport(task: AgentTaskRecord, steps: AgentTaskStepRecord[]): AgentResultReport {
    const completed = steps.filter((s) => s.status === 'completed').length;
    const failed = steps.filter((s) => s.status === 'failed' || s.status === 'rejected').length;
    const pendingApprovals = steps.filter((s) => s.status === 'awaiting_approval').length;

    const artifacts: Array<{ path: string; bytes: number }> = [];
    const stepOutcomes = steps.map((s) => {
      const outSummary =
        typeof s.output?.summary === 'string'
          ? s.output.summary
          : s.status === 'awaiting_approval'
            ? 'Paused awaiting explicit operator approval.'
            : s.error_message || 'Pending execution.';
      const dataObj = (s.output?.data || {}) as Record<string, unknown>;
      if (s.tool_name === 'create_document' && s.status === 'completed' && typeof dataObj.path === 'string') {
        artifacts.push({
          path: dataObj.path,
          bytes: Number(dataObj.bytes || 0),
        });
      }
      return {
        step_index: s.step_index,
        title: s.title,
        tool_name: s.tool_name,
        status: s.status,
        summary: outSummary,
        ...(s.error_message ? { error: s.error_message } : {}),
      };
    });

    let summary = task.result_summary;
    if (!summary) {
      if (task.status === 'completed') {
        summary = `Completed ${completed}/${steps.length} step(s).` +
          (artifacts.length > 0 ? ` Created ${artifacts.length} document(s).` : '');
      } else if (task.status === 'awaiting_approval') {
        summary = `Execution paused at step ${task.current_step_index + 1}/${steps.length} awaiting operator approval.`;
      } else if (task.status === 'failed') {
        summary = task.error_message || `Execution failed with ${failed} failed step(s).`;
      } else if (task.status === 'cancelled') {
        summary = 'Task cancelled by operator.';
      } else {
        summary = `Planned ${steps.length} sequential step(s); ready to execute.`;
      }
    }

    return {
      task_id: task.id,
      title: task.title,
      status: task.status,
      completed_steps: completed,
      total_steps: steps.length,
      failed_steps: failed,
      pending_approvals: pendingApprovals,
      summary,
      artifacts_created: artifacts,
      step_outcomes: stepOutcomes,
    };
  }
}

export const defaultResultReporter = new AgentResultReporter();
