import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  Clock,
  FileCode2,
  History,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  AgentBlueprint,
  AgentExecutionHistoryItem,
  AgentTaskDetail,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentToolDescriptor,
  MemoryCategory,
} from '../../types/genesis';

type AgentTab = 'tasks' | 'agents_tools' | 'history';

const STATUS_BADGE_MAP: Record<AgentTaskStatus, { label: string; className: string }> = {
  planned: { label: 'Planned', className: 'text-blue-300 bg-blue-500/10 border-blue-500/30' },
  running: { label: 'Running', className: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30' },
  awaiting_approval: {
    label: 'Awaiting Approval',
    className: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  },
  completed: {
    label: 'Completed',
    className: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  },
  failed: { label: 'Failed', className: 'text-red-300 bg-red-500/10 border-red-500/30' },
  cancelled: { label: 'Cancelled', className: 'text-slate-400 bg-white/[0.05] border-white/[0.1]' },
};

export const GenesisAgentModule: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AgentTab>('tasks');
  const [agents, setAgents] = useState<AgentBlueprint[]>([]);
  const [tools, setTools] = useState<AgentToolDescriptor[]>([]);
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const [globalHistory, setGlobalHistory] = useState<AgentExecutionHistoryItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<AgentTaskDetail | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // New Task Form
  const [showNewTask, setShowNewTask] = useState(false);
  const [taskAgentId, setTaskAgentId] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskGoal, setTaskGoal] = useState('');
  const [targetFilePath, setTargetFilePath] = useState('workspace_readme.txt');
  const [documentFilename, setDocumentFilename] = useState('');
  const [codeSnippet, setCodeSnippet] = useState('');

  // Approval note + Save Memory prompt
  const [approvalNote, setApprovalNote] = useState('');
  const [showSaveMemory, setShowSaveMemory] = useState(false);
  const [memTitle, setMemTitle] = useState('');
  const [memCategory, setMemCategory] = useState<MemoryCategory>('fact');
  const [memContent, setMemContent] = useState('');

  // Blueprints & Tools tab state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [agentDescription, setAgentDescription] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentMaxSteps, setAgentMaxSteps] = useState(6);
  const [agentSelectedTools, setAgentSelectedTools] = useState<string[]>([
    'retrieve_memory',
    'retrieve_knowledge',
    'read_workspace_file',
    'local_workspace_ops',
  ]);
  const [dryRunTask, setDryRunTask] = useState(
    'Verify workspace health, check memory index, and summarize model manifests.'
  );
  const [traceResult, setTraceResult] = useState<Array<{
    step: number;
    action: string;
    status: string;
    detail: string;
  }> | null>(null);

  const loadTaskDetail = useCallback(async (taskId: string) => {
    try {
      const detail = await apiClient.getAgentTask(taskId);
      setTaskDetail(detail);
      setShowSaveMemory(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task details.');
    }
  }, []);

  const loadWorkspace = useCallback(
    async (filterStatus = statusFilter) => {
      setLoading(true);
      try {
        const [agentList, toolList, taskList, historyList] = await Promise.all([
          apiClient.listAgents(),
          apiClient.listAgentTools(),
          apiClient.listAgentTasks(filterStatus),
          apiClient.listAgentHistory({ limit: 80 }),
        ]);
        setAgents(agentList);
        setTools(toolList);
        setTasks(taskList);
        setGlobalHistory(historyList);

        if (agentList.length > 0) {
          setTaskAgentId((prev) => {
            if (prev && agentList.some((a) => a.id === prev)) return prev;
            const preferred = agentList.find((a) => a.id === 'agent-task-operator') || agentList[0];
            return preferred.id;
          });
          setSelectedAgentId((prev) =>
            prev && agentList.some((a) => a.id === prev) ? prev : agentList[0].id
          );
        }

        if (taskList.length > 0) {
          const nextId =
            selectedTaskId && taskList.some((t) => t.id === selectedTaskId)
              ? selectedTaskId
              : taskList[0].id;
          setSelectedTaskId(nextId);
          const detail = await apiClient.getAgentTask(nextId);
          setTaskDetail(detail);
        } else {
          setSelectedTaskId(null);
          setTaskDetail(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Agent OS workspace.');
      } finally {
        setLoading(false);
      }
    },
    [selectedTaskId, statusFilter]
  );

  useEffect(() => {
    void loadWorkspace(statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const handleCreateTask = async (autoRun: boolean) => {
    if (!taskAgentId || !taskGoal.trim()) return;
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      const detail = await apiClient.createAgentTask({
        agent_id: taskAgentId,
        goal: taskGoal.trim(),
        title: taskTitle.trim() || undefined,
        target_file_path: targetFilePath.trim() || undefined,
        document_filename: documentFilename.trim() || undefined,
        code_snippet: codeSnippet.trim() || undefined,
        auto_run: autoRun,
      });
      setTaskDetail(detail);
      setSelectedTaskId(detail.task.id);
      setShowNewTask(false);
      setTaskTitle('');
      setTaskGoal('');
      setDocumentFilename('');
      setCodeSnippet('');
      setBanner(
        autoRun
          ? `Task '${detail.task.title}' planned and executed (${detail.task.status}).`
          : `Execution plan generated with ${detail.steps.length} step(s).`
      );
      await loadWorkspace(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task.');
    } finally {
      setBusy(false);
    }
  };

  const handleRunTask = async (taskId: string) => {
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      const detail = await apiClient.runAgentTask(taskId);
      setTaskDetail(detail);
      await loadWorkspace(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Task execution failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleStepApproval = async (taskId: string, stepId: string, approved: boolean) => {
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      const detail = await apiClient.approveAgentTaskStep(taskId, stepId, {
        approved,
        note: approvalNote.trim() || undefined,
        resume: approved,
      });
      setTaskDetail(detail);
      setApprovalNote('');
      setBanner(
        approved
          ? 'Step approved by operator and sequential execution resumed.'
          : 'Consequential step rejected; task halted safely.'
      );
      await loadWorkspace(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit approval decision.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await apiClient.cancelAgentTask(taskId);
      setTaskDetail(detail);
      await loadWorkspace(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel task.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.deleteAgentTask(taskId);
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
        setTaskDetail(null);
      }
      await loadWorkspace(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task.');
    } finally {
      setBusy(false);
    }
  };

  const openSaveMemoryForm = () => {
    if (!taskDetail) return;
    setMemTitle(`Agent Result: ${taskDetail.task.title}`.slice(0, 140));
    setMemCategory('fact');
    setMemContent(taskDetail.report.summary);
    setShowSaveMemory(true);
  };

  const handleSaveTaskMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskDetail) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.saveAgentTaskMemory(taskDetail.task.id, {
        approved: true,
        title: memTitle.trim(),
        content: memContent.trim(),
        category: memCategory,
        tags: ['agent-result', taskDetail.task.status],
      });
      setShowSaveMemory(false);
      setBanner('Task result approved and saved to User Memory.');
      await loadTaskDetail(taskDetail.task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task memory.');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiClient.createAgent({
        name: agentName,
        role: agentRole,
        description: agentDescription,
        allowed_tools: agentSelectedTools,
        sandbox_policy: { max_steps: agentMaxSteps, workspace_scope: './data/agent_workspace' },
        system_prompt: agentPrompt,
      });
      setAgents((prev) => [created, ...prev]);
      setSelectedAgentId(created.id);
      setTaskAgentId(created.id);
      setShowCreateAgent(false);
      setAgentName('');
      setAgentRole('');
      setAgentDescription('');
      setAgentPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent blueprint.');
    }
  };

  const handleDeleteAgent = async (id: string) => {
    setError(null);
    try {
      await apiClient.deleteAgent(id);
      await loadWorkspace(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete agent.');
    }
  };

  const handleDryRun = async () => {
    if (!selectedAgentId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.dryRunAgent(selectedAgentId, dryRunTask);
      setTraceResult(res.trace);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dry-run execution failed.');
    } finally {
      setBusy(false);
    }
  };

  const awaitingApprovalCount = tasks.filter((t) => t.status === 'awaiting_approval').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const failedCount = tasks.filter((t) => t.status === 'failed').length;
  const operationalTools = tools.filter((t) => t.operational);
  const reservedTools = tools.filter((t) => !t.operational);
  const activeAgent = agents.find((a) => a.id === selectedAgentId) || null;
  const pendingApprovalStep =
    taskDetail?.steps.find((s) => s.status === 'awaiting_approval') || null;

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Genesis Agent Operating System
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Plan multi-step tasks, enforce allowlisted tools and operator approvals, integrate Memory & Knowledge, and audit execution history.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadWorkspace(statusFilter)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('tasks');
                setShowNewTask((v) => !v);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{showNewTask ? 'Close Task Builder' : 'New Agent Task'}</span>
            </button>
          </div>
        </div>

        {/* Status Summary Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="text-xs text-slate-400">Total Tasks</div>
            <div className="text-xl font-semibold text-slate-100 mt-1 tabular-nums">{tasks.length}</div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="text-xs text-slate-400">Awaiting Approval</div>
            <div className="text-xl font-semibold text-amber-300 mt-1 tabular-nums">
              {awaitingApprovalCount}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="text-xs text-slate-400">Completed</div>
            <div className="text-xl font-semibold text-emerald-400 mt-1 tabular-nums">
              {completedCount}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="text-xs text-slate-400">Failed</div>
            <div className="text-xl font-semibold text-red-400 mt-1 tabular-nums">{failedCount}</div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 col-span-2 lg:col-span-1">
            <div className="text-xs text-slate-400">Operational Tools</div>
            <div className="text-xl font-semibold text-blue-300 mt-1 tabular-nums">
              {operationalTools.length}
              <span className="text-xs font-normal text-slate-500 ml-1">
                (+{reservedTools.length} stub)
              </span>
            </div>
          </div>
        </div>

        {/* Workspace Navigation Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-white/[0.08] pb-3">
          {[
            { id: 'tasks' as const, label: 'Tasks, Plans & Approvals', icon: ListChecks },
            { id: 'agents_tools' as const, label: 'Agent Blueprints & Tool Registry', icon: Wrench },
            { id: 'history' as const, label: 'Execution History', icon: History },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-600/15 border border-blue-500/40 text-blue-300'
                    : 'bg-[#11161F] border border-white/[0.08] text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {banner && (
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200 flex items-center justify-between gap-2">
            <span>{banner}</span>
            <button type="button" onClick={() => setBanner(null)} className="cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* TAB 1: TASKS, EXECUTION PLANS & APPROVALS */}
        {activeTab === 'tasks' && (
          <div className="space-y-6">
            {showNewTask && (
              <div className="rounded-xl border border-white/[0.1] bg-[#11161F] p-6 space-y-4">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Create & Plan New Agent Task
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">Assigned Agent</label>
                    <select
                      value={taskAgentId}
                      onChange={(e) => setTaskAgentId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                    >
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.allowed_tools.length} tools)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">
                      Task Title (optional)
                    </label>
                    <input
                      type="text"
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      placeholder="Auto-derived from goal if omitted"
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">Task Goal / Request</label>
                  <textarea
                    rows={3}
                    value={taskGoal}
                    onChange={(e) => setTaskGoal(e.target.value)}
                    placeholder="e.g., Inspect workspace_readme.txt, search User Memory & Knowledge Base, and create a markdown summary document."
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">
                      Workspace File Path (for read_workspace_file)
                    </label>
                    <input
                      type="text"
                      value={targetFilePath}
                      onChange={(e) => setTargetFilePath(e.target.value)}
                      placeholder="workspace_readme.txt"
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">
                      Output Document Filename (optional, approval-gated)
                    </label>
                    <input
                      type="text"
                      value={documentFilename}
                      onChange={(e) => setDocumentFilename(e.target.value)}
                      placeholder="e.g., workspace_audit.md"
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">
                    Restricted Code Expression (optional, isolated sandbox, approval-gated)
                  </label>
                  <textarea
                    rows={2}
                    value={codeSnippet}
                    onChange={(e) => setCodeSnippet(e.target.value)}
                    placeholder="e.g., const total = [4, 8, 16].reduce((a, b) => a + b, 0); console.log('Total:', total); total;"
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="flex flex-wrap justify-end gap-2.5">
                  <button
                    type="button"
                    disabled={busy || !taskGoal.trim() || !taskAgentId}
                    onClick={() => void handleCreateTask(false)}
                    className="px-4 py-2 rounded-lg border border-white/[0.12] bg-[#161C26] hover:bg-[#1E2634] disabled:opacity-40 text-xs font-medium text-slate-200 cursor-pointer"
                  >
                    Generate Plan Only
                  </button>
                  <button
                    type="button"
                    disabled={busy || !taskGoal.trim() || !taskAgentId}
                    onClick={() => void handleCreateTask(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Plan & Run Sequentially</span>
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Filterable Task List */}
              <div className="lg:col-span-4 space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {(['all', 'planned', 'running', 'awaiting_approval', 'completed', 'failed'] as const).map(
                    (st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setStatusFilter(st)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize cursor-pointer ${
                          statusFilter === st
                            ? 'bg-blue-600 text-white'
                            : 'bg-[#11161F] border border-white/[0.08] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {st.replace('_', ' ')}
                      </button>
                    )
                  )}
                </div>

                {loading ? (
                  <div className="h-28 rounded-xl bg-[#11161F] border border-white/[0.06]" />
                ) : tasks.length === 0 ? (
                  <div className="p-6 rounded-xl border border-white/[0.08] bg-[#11161F] text-xs text-slate-400">
                    No tasks found for this filter. Click &ldquo;New Agent Task&rdquo; to plan an action sequence.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((task) => {
                      const badge = STATUS_BADGE_MAP[task.status] || STATUS_BADGE_MAP.planned;
                      const isSelected = task.id === selectedTaskId;
                      return (
                        <div
                          key={task.id}
                          className={`p-4 rounded-xl border transition-colors ${
                            isSelected
                              ? 'bg-[#141B26] border-blue-500/50'
                              : 'bg-[#11161F] border-white/[0.08]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedTaskId(task.id);
                                void loadTaskDetail(task.id);
                              }}
                              className="text-left flex-1 min-w-0 cursor-pointer"
                            >
                              <div className="text-sm font-semibold text-slate-100 truncate">
                                {task.title}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                                {task.agent_name || task.agent_id}
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteTask(task.id)}
                              aria-label={`Delete task ${task.title}`}
                              className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="mt-2.5 flex items-center justify-between gap-2">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                            <span className="text-[11px] text-slate-500 tabular-nums">
                              {task.completed_steps ?? 0}/{task.step_count ?? 0} steps
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right: Selected Task Detail, Plan, Approvals, Result Report */}
              <div className="lg:col-span-8 space-y-5">
                {!taskDetail ? (
                  <div className="p-8 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-xs text-slate-400">
                    Select an agent task on the left or create a new task to inspect its execution plan and approvals.
                  </div>
                ) : (
                  <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-5">
                    {/* Task Header */}
                    <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-white/[0.08]">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-lg font-semibold text-slate-100">
                            {taskDetail.task.title}
                          </h3>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${
                              STATUS_BADGE_MAP[taskDetail.task.status].className
                            }`}
                          >
                            {STATUS_BADGE_MAP[taskDetail.task.status].label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          {taskDetail.task.goal}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {(taskDetail.task.status === 'planned' ||
                          taskDetail.task.status === 'running') && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRunTask(taskDetail.task.id)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Execute Plan</span>
                          </button>
                        )}
                        {(taskDetail.task.status === 'planned' ||
                          taskDetail.task.status === 'running' ||
                          taskDetail.task.status === 'awaiting_approval') && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleCancelTask(taskDetail.task.id)}
                            className="px-3 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Pending Approval Banner */}
                    {pendingApprovalStep && (
                      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                        <div className="flex items-start gap-2.5">
                          <ShieldAlert className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <div className="text-xs font-semibold text-amber-200">
                              Operator Approval Required — Step {pendingApprovalStep.step_index + 1}:{' '}
                              {pendingApprovalStep.title}
                            </div>
                            <p className="text-xs text-amber-100/80 mt-1">
                              Tool <span className="font-mono">{pendingApprovalStep.tool_name}</span> is
                              classified as a consequential action and will not execute without your explicit authorization.
                            </p>
                          </div>
                        </div>

                        <pre className="p-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.08] font-mono text-[11px] text-slate-300 overflow-x-auto max-h-40">
                          {JSON.stringify(pendingApprovalStep.tool_input, null, 2)}
                        </pre>

                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={approvalNote}
                            onChange={(e) => setApprovalNote(e.target.value)}
                            placeholder="Optional approval / rejection audit note..."
                            className="flex-1 px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                          />
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handleStepApproval(
                                  taskDetail.task.id,
                                  pendingApprovalStep.id,
                                  false
                                )
                              }
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-500/15 hover:bg-red-500/25 text-xs font-medium text-red-200 cursor-pointer"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>Reject</span>
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handleStepApproval(
                                  taskDetail.task.id,
                                  pendingApprovalStep.id,
                                  true
                                )
                              }
                              className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Approve & Continue</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Attached Memory & Knowledge Context */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                        <div className="text-slate-400 font-medium mb-1">
                          Approved Memory Context ({taskDetail.task.memory_context.memories.length})
                        </div>
                        {taskDetail.task.memory_context.memories.length === 0 ? (
                          <div className="text-slate-500">No matching approved memories linked.</div>
                        ) : (
                          <ul className="space-y-1 text-slate-300">
                            {taskDetail.task.memory_context.memories.map((m) => (
                              <li key={m.id} className="truncate">
                                · [{m.category}] {m.title}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                        <div className="text-slate-400 font-medium mb-1">
                          Knowledge Base Context ({taskDetail.task.memory_context.knowledge.length})
                        </div>
                        {taskDetail.task.memory_context.knowledge.length === 0 ? (
                          <div className="text-slate-500">No matching knowledge chunks linked.</div>
                        ) : (
                          <ul className="space-y-1 text-slate-300">
                            {taskDetail.task.memory_context.knowledge.map((k) => (
                              <li key={`${k.document_id}-${k.chunk_index}`} className="truncate">
                                · {k.document_title} (#{k.chunk_index})
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    {/* Execution Plan Steps */}
                    <div className="space-y-2.5">
                      <div className="text-xs font-semibold text-slate-300">
                        Sequential Execution Plan ({taskDetail.steps.length} step(s))
                      </div>
                      <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-xl bg-[#0A0D12]">
                        {taskDetail.steps.map((step) => (
                          <div key={step.id} className="p-4 space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                {step.status === 'completed' ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : step.status === 'failed' || step.status === 'rejected' ? (
                                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                                ) : step.status === 'awaiting_approval' ? (
                                  <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0" />
                                ) : (
                                  <Clock className="w-4 h-4 text-slate-500 shrink-0" />
                                )}
                                <span className="text-xs font-semibold text-slate-200 tabular-nums">
                                  0{step.step_index + 1}. {step.title}
                                </span>
                                <span className="px-2 py-0.5 rounded bg-white/[0.05] font-mono text-[10px] text-blue-300">
                                  {step.tool_name}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-slate-400 tabular-nums">
                                {step.requires_approval && (
                                  <span className="text-amber-300">
                                    Approval: {step.approval_status}
                                  </span>
                                )}
                                <span className="capitalize font-medium text-slate-300">
                                  {step.status.replace('_', ' ')}
                                </span>
                              </div>
                            </div>

                            <div className="text-xs text-slate-400">{step.description}</div>

                            {step.output?.summary && (
                              <div className="p-2.5 rounded-lg bg-[#11161F] border border-white/[0.06] text-xs text-slate-300 space-y-1.5">
                                <div className="font-medium text-emerald-300">{step.output.summary}</div>
                                {step.output.data && Object.keys(step.output.data).length > 0 && (
                                  <pre className="font-mono text-[11px] text-slate-400 overflow-x-auto max-h-36">
                                    {JSON.stringify(step.output.data, null, 2)}
                                  </pre>
                                )}
                              </div>
                            )}

                            {step.error_message && (
                              <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                                {step.error_message}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Result Report & Optional Approved Memory Save */}
                    <div className="rounded-xl border border-white/[0.08] bg-[#0A0D12] p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-200">Result Report</div>
                        {taskDetail.task.status === 'completed' && (
                          <button
                            type="button"
                            onClick={openSaveMemoryForm}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-xs font-medium text-blue-300 cursor-pointer"
                          >
                            <BookmarkPlus className="w-3.5 h-3.5" />
                            <span>Save Result to Memory</span>
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {taskDetail.report.summary}
                      </p>
                      {taskDetail.report.artifacts_created.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {taskDetail.report.artifacts_created.map((art) => (
                            <span
                              key={art.path}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#11161F] border border-emerald-500/30 font-mono text-[11px] text-emerald-300"
                            >
                              <FileCode2 className="w-3.5 h-3.5" />
                              {art.path} ({art.bytes} B)
                            </span>
                          ))}
                        </div>
                      )}

                      {showSaveMemory && (
                        <form
                          onSubmit={handleSaveTaskMemory}
                          className="p-3.5 rounded-lg bg-[#11161F] border border-blue-500/30 space-y-2.5 text-xs"
                        >
                          <div className="font-medium text-blue-300">
                            Explicitly Approve Saving Task Result to User Memory
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                              type="text"
                              required
                              value={memTitle}
                              onChange={(e) => setMemTitle(e.target.value)}
                              className="sm:col-span-2 px-2.5 py-1.5 rounded bg-[#0A0D12] border border-white/[0.1] text-slate-100 focus:outline-none"
                            />
                            <select
                              value={memCategory}
                              onChange={(e) => setMemCategory(e.target.value as MemoryCategory)}
                              className="px-2.5 py-1.5 rounded bg-[#0A0D12] border border-white/[0.1] text-slate-100 focus:outline-none"
                            >
                              <option value="fact">Fact</option>
                              <option value="preference">Preference</option>
                              <option value="instruction">Instruction</option>
                              <option value="constraint">Constraint</option>
                            </select>
                          </div>
                          <textarea
                            rows={2}
                            required
                            value={memContent}
                            onChange={(e) => setMemContent(e.target.value)}
                            className="w-full px-2.5 py-1.5 rounded bg-[#0A0D12] border border-white/[0.1] text-slate-100 focus:outline-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setShowSaveMemory(false)}
                              className="px-2.5 py-1 rounded border border-white/[0.1] text-slate-300 cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={busy}
                              className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium cursor-pointer"
                            >
                              Approve & Save
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: AGENT BLUEPRINTS & TOOL REGISTRY */}
        {activeTab === 'agents_tools' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-slate-400">
                Configure modular Agent Blueprints with strict tool allowlists and inspect the Step 07 Tool Registry.
              </div>
              <button
                type="button"
                onClick={() => setShowCreateAgent((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{showCreateAgent ? 'Cancel' : 'New Agent Blueprint'}</span>
              </button>
            </div>

            {showCreateAgent && (
              <form
                onSubmit={handleCreateAgent}
                className="rounded-xl border border-white/[0.1] bg-[#11161F] p-6 space-y-4"
              >
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Create Sandboxed Agent Blueprint
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">Agent Name</label>
                    <input
                      type="text"
                      required
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      placeholder="e.g., Knowledge Auditor"
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">Role</label>
                    <input
                      type="text"
                      required
                      value={agentRole}
                      onChange={(e) => setAgentRole(e.target.value)}
                      placeholder="e.g., Local Research & File Operator"
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                    />
                  </div>
                </div>
                <input
                  type="text"
                  value={agentDescription}
                  onChange={(e) => setAgentDescription(e.target.value)}
                  placeholder="Describe workspace scope and responsibilities"
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                />
                <div>
                  <label className="block text-xs text-slate-300 mb-2">
                    Tool Allowlist (Operational Tools Only)
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {operationalTools.map((tool) => {
                      const checked = agentSelectedTools.includes(tool.id);
                      return (
                        <label
                          key={tool.id}
                          className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer ${
                            checked
                              ? 'bg-blue-500/10 border-blue-500/40'
                              : 'bg-[#0A0D12] border-white/[0.08]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setAgentSelectedTools((prev) =>
                                prev.includes(tool.id)
                                  ? prev.filter((t) => t !== tool.id)
                                  : [...prev, tool.id]
                              )
                            }
                            className="mt-0.5 accent-blue-500"
                          />
                          <div>
                            <div className="text-xs font-medium text-slate-200">
                              {tool.name}
                              {tool.requires_approval && (
                                <span className="ml-1.5 text-[10px] text-amber-300">
                                  (Approval Required)
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400">{tool.description}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">Max Steps</label>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={agentMaxSteps}
                      onChange={(e) => setAgentMaxSteps(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-300 mb-1.5">System Instruction</label>
                    <input
                      type="text"
                      value={agentPrompt}
                      onChange={(e) => setAgentPrompt(e.target.value)}
                      placeholder="Operate strictly inside approved local workspace..."
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                  >
                    Save Blueprint
                  </button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-4 space-y-2">
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className={`p-4 rounded-xl border ${
                      agent.id === activeAgent?.id
                        ? 'bg-[#141B26] border-blue-500/50'
                        : 'bg-[#11161F] border-white/[0.08]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAgentId(agent.id);
                          setTraceResult(null);
                        }}
                        className="text-left flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="text-sm font-semibold text-slate-100 truncate">
                          {agent.name}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 truncate">{agent.role}</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteAgent(agent.id)}
                        aria-label={`Delete ${agent.name}`}
                        className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
                      {agent.allowed_tools.length} tools · Max {agent.sandbox_policy.max_steps} steps
                    </div>
                  </div>
                ))}
              </div>

              <div className="lg:col-span-8 space-y-5">
                {activeAgent && (
                  <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-white/[0.08]">
                      <div>
                        <h3 className="font-display text-base font-semibold text-slate-100">
                          {activeAgent.name}
                        </h3>
                        <div className="text-xs text-slate-400">{activeAgent.role}</div>
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                        <Shield className="w-4 h-4" />
                        <span>Sandbox Enforced</span>
                      </span>
                    </div>
                    <p className="text-xs text-slate-300">{activeAgent.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {activeAgent.allowed_tools.map((t) => (
                        <span
                          key={t}
                          className="px-2 py-1 rounded bg-[#0A0D12] border border-white/[0.08] font-mono text-[11px] text-blue-300"
                        >
                          {t}
                        </span>
                      ))}
                    </div>

                    <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
                      <label className="block text-xs font-medium text-slate-300">
                        Diagnostic Dry-Run Check
                      </label>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={dryRunTask}
                          onChange={(e) => setDryRunTask(e.target.value)}
                          className="flex-1 px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDryRun()}
                          className="px-4 py-2 rounded-lg border border-white/[0.12] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer shrink-0"
                        >
                          Run Dry-Run Trace
                        </button>
                      </div>
                      {traceResult && (
                        <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg bg-[#0A0D12]">
                          {traceResult.map((item) => (
                            <div key={item.step} className="p-3 text-xs">
                              <div className="font-semibold text-slate-200">
                                0{item.step}. {item.action}
                              </div>
                              <div className="text-slate-400 mt-0.5">{item.detail}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Registered Tool Catalog */}
                <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    Tool Registry (Implemented & Reserved Interfaces)
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {tools.map((tool) => (
                      <div
                        key={tool.id}
                        className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07] space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-200">{tool.name}</span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                              !tool.operational
                                ? 'bg-slate-500/15 text-slate-400'
                                : tool.requires_approval
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-emerald-500/15 text-emerald-300'
                            }`}
                          >
                            {!tool.operational
                              ? 'Interface Reserved'
                              : tool.requires_approval
                                ? 'Approval Gate'
                                : 'Read-Only Safe'}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-blue-300">{tool.id}</div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          {tool.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: EXECUTION HISTORY */}
        {activeTab === 'history' && (
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Audit & Execution History ({globalHistory.length} event(s))
              </span>
            </div>
            {globalHistory.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No agent execution events recorded yet.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.06] text-xs">
                {globalHistory.map((item) => (
                  <div
                    key={item.id}
                    className="px-5 py-3 flex flex-wrap items-start justify-between gap-3"
                  >
                    <div className="space-y-0.5 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-blue-300">
                          {item.event_type}
                        </span>
                        {item.tool_name && (
                          <span className="px-1.5 py-0.5 rounded bg-[#0A0D12] border border-white/[0.08] font-mono text-[10px] text-slate-300">
                            {item.tool_name}
                          </span>
                        )}
                      </div>
                      <div className="text-slate-300">{item.detail}</div>
                    </div>
                    <div className="text-[11px] text-slate-500 tabular-nums shrink-0">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
