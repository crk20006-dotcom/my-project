import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Code2,
  FileText,
  FolderKanban,
  Presentation,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { ApiRequestError, apiClient } from '../../services/apiClient';
import type {
  AgentBlueprint,
  CreatorProject,
  CreatorProjectFile,
  CreatorRevision,
  LaboratoryItem,
  PresentationDeck,
  ResearchProject,
} from '../../types/genesis';
import { CodingWorkspace } from '../creator/CodingWorkspace';
import { DocumentWorkspace } from '../creator/DocumentWorkspace';
import { PresentationWorkspace } from '../creator/PresentationWorkspace';
import { ProjectsWorkspace } from '../creator/ProjectsWorkspace';

type CreatorWorkspaceTab = 'coding' | 'documents' | 'presentations' | 'projects';

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  tone: 'warning' | 'danger' | 'primary';
  onConfirm: () => Promise<void>;
}

export const GenesisCreatorModule: React.FC = () => {
  const [activeTab, setActiveTab] = useState<CreatorWorkspaceTab>('coding');
  const [projects, setProjects] = useState<CreatorProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [files, setFiles] = useState<CreatorProjectFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string>('');

  const [researchList, setResearchList] = useState<ResearchProject[]>([]);
  const [labItems, setLabItems] = useState<LaboratoryItem[]>([]);
  const [agents, setAgents] = useState<AgentBlueprint[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const loadFiles = useCallback(async (projectId: string) => {
    if (!projectId) {
      setFiles([]);
      return;
    }
    const list = await apiClient.listCreatorFiles(projectId);
    setFiles(list);
    setActiveFileId((prev) => {
      if (prev && list.some((f) => f.id === prev)) return prev;
      return list[0]?.id || '';
    });
  }, []);

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projList, resList, labs, agList] = await Promise.all([
        apiClient.listCreatorProjects(),
        apiClient.listResearch(),
        apiClient.listLaboratory(),
        apiClient.listAgents(),
      ]);
      setProjects(projList);
      setResearchList(resList);
      setLabItems(labs);
      setAgents(agList);

      const targetProj =
        projList.find((p) => p.id === selectedProjectId)?.id || projList[0]?.id || '';
      setSelectedProjectId(targetProj);
      if (targetProj) {
        await loadFiles(targetProj);
      } else {
        setFiles([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Creator Studio.');
    } finally {
      setLoading(false);
    }
  }, [loadFiles, selectedProjectId]);

  useEffect(() => {
    void loadWorkspaceData();
  }, []);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const activeFile = useMemo(
    () => files.find((f) => f.id === activeFileId) || null,
    [files, activeFileId]
  );

  const handleSelectProject = async (proj: CreatorProject) => {
    setSelectedProjectId(proj.id);
    setActiveFileId('');
    setNotice(null);
    setError(null);
    try {
      await loadFiles(proj.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project files.');
    }
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateFile = async (payload: {
    filename: string;
    kind: 'code' | 'document' | 'presentation';
    format: string;
    content: string;
  }) => {
    if (!activeProject) {
      setError('Select or create a project first.');
      return;
    }
    setError(null);
    try {
      const created = await apiClient.createCreatorFile(activeProject.id, payload);
      await loadFiles(activeProject.id);
      setActiveFileId(created.id);
      setNotice(`Created ${created.filename} (v${created.version}).`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConfirmDialog({
          title: 'Overwrite Existing File?',
          message: `"${err.existingName || payload.filename}" already exists in "${activeProject.name}". Replacing it will create a new revision and overwrite the current file contents.`,
          confirmLabel: 'Confirm Overwrite',
          tone: 'warning',
          onConfirm: async () => {
            const overwritten = await apiClient.createCreatorFile(activeProject.id, {
              ...payload,
              overwrite: true,
            });
            await loadFiles(activeProject.id);
            setActiveFileId(overwritten.id);
            setNotice(`Overwrote ${overwritten.filename} (now v${overwritten.version}).`);
          },
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to create file.');
    }
  };

  const handleSaveFile = async (
    fileId: string,
    payload: { filename?: string; format?: string; content: string; summary?: string }
  ) => {
    setError(null);
    try {
      const updated = await apiClient.updateCreatorFile(fileId, payload);
      await loadFiles(updated.project_id);
      setActiveFileId(updated.id);
      setNotice(`Saved ${updated.filename} (v${updated.version}).`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConfirmDialog({
          title: 'Confirm Target File Overwrite',
          message: `Another file named "${err.existingName || payload.filename}" already exists in this project. Confirm to overwrite it.`,
          confirmLabel: 'Overwrite Target',
          tone: 'warning',
          onConfirm: async () => {
            const updated = await apiClient.updateCreatorFile(fileId, {
              ...payload,
              overwrite: true,
            });
            await loadFiles(updated.project_id);
            setActiveFileId(updated.id);
            setNotice(`Saved and replaced ${updated.filename} (v${updated.version}).`);
          },
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to save file.');
    }
  };

  const handleUploadFile = async (
    filename: string,
    encoding: 'utf8' | 'base64',
    data: string
  ) => {
    if (!activeProject) {
      setError('Select or create a project first.');
      return;
    }
    setError(null);
    try {
      const res = await apiClient.uploadCreatorFile({
        project_id: activeProject.id,
        filename,
        encoding,
        data,
      });
      if (res.type === 'project_file') {
        await loadFiles(activeProject.id);
        setActiveFileId(res.file.id);
        setNotice(`Imported "${res.file.filename}" into workspace.`);
        if (res.file.kind === 'code') setActiveTab('coding');
        else if (res.file.kind === 'presentation') setActiveTab('presentations');
        else setActiveTab('documents');
      } else {
        setNotice(`Validated image asset "${res.name}" (${res.size} bytes).`);
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConfirmDialog({
          title: 'Overwrite File on Upload?',
          message: `Uploading "${filename}" would overwrite existing workspace file "${err.existingName || filename}". Confirm to replace it and preserve previous versions in revision history.`,
          confirmLabel: 'Replace File',
          tone: 'warning',
          onConfirm: async () => {
            const res = await apiClient.uploadCreatorFile({
              project_id: activeProject.id,
              filename,
              encoding,
              data,
              overwrite: true,
            });
            if (res.type === 'project_file') {
              await loadFiles(activeProject.id);
              setActiveFileId(res.file.id);
              setNotice(`Replaced "${res.file.filename}" (v${res.file.version}).`);
            }
          },
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Upload validation failed.');
    }
  };

  const handleUploadImageAsset = async (filename: string, base64Data: string) => {
    if (!activeProject) return null;
    setError(null);
    try {
      const res = await apiClient.uploadCreatorFile({
        project_id: activeProject.id,
        filename,
        encoding: 'base64',
        data: base64Data,
      });
      if (res.type === 'image_asset') {
        setNotice(`Attached validated image "${res.name}".`);
        return { name: res.name, mimeType: res.mimeType, dataUrl: res.dataUrl };
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image validation failed.');
      return null;
    }
  };

  const handleExportFile = async (payload: {
    title: string;
    filename?: string;
    format: string;
    content: string;
    saveToWorkspace: boolean;
  }) => {
    setError(null);
    const runExport = async (overwrite = false) => {
      const { blob, filename } = await apiClient.exportCreatorBlob({
        project_id: activeProject?.id,
        title: payload.title,
        filename: payload.filename,
        export_format: payload.format,
        content: payload.content,
        save_to_workspace: payload.saveToWorkspace,
        overwrite,
      });
      triggerDownload(blob, filename);
      setNotice(`Exported ${filename} (${blob.size} bytes).`);
    };

    try {
      await runExport(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConfirmDialog({
          title: 'Overwrite Workspace Export on Disk?',
          message: `Export file "${err.existingName}" already exists inside the project workspace folder. Confirm to overwrite it.`,
          confirmLabel: 'Overwrite Export',
          tone: 'warning',
          onConfirm: async () => {
            await runExport(true);
          },
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Export failed.');
    }
  };

  const handleExportDeck = async (payload: {
    title: string;
    deck: PresentationDeck;
    saveToWorkspace: boolean;
  }) => {
    setError(null);
    const runExport = async (overwrite = false) => {
      const { blob, filename } = await apiClient.exportCreatorBlob({
        project_id: activeProject?.id,
        title: payload.title,
        export_format: 'pptx',
        deck: payload.deck,
        save_to_workspace: payload.saveToWorkspace,
        overwrite,
      });
      triggerDownload(blob, filename);
      setNotice(`Exported PowerPoint deck ${filename} (${blob.size} bytes).`);
    };

    try {
      await runExport(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConfirmDialog({
          title: 'Overwrite PPTX Export on Disk?',
          message: `Export file "${err.existingName}" already exists in the project workspace folder. Confirm to overwrite it.`,
          confirmLabel: 'Overwrite PPTX',
          tone: 'warning',
          onConfirm: async () => {
            await runExport(true);
          },
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'PPTX export failed.');
    }
  };

  const handleSaveToMemory = (fileId: string, title: string) => {
    setConfirmDialog({
      title: 'Save Snippet to Approved User Memory',
      message: `Confirm saving a snippet from "${title}" to your long-term Project Memory? Project Genesis never saves user memory automatically without approval.`,
      confirmLabel: 'Approve & Save Memory',
      tone: 'primary',
      onConfirm: async () => {
        const saved = await apiClient.saveCreatorFileToMemory(fileId, {
          approved: true,
          title,
          namespace: 'project',
          category: 'fact',
        });
        setNotice(`Saved "${saved.title}" to Approved User Memory.`);
      },
    });
  };

  const handleSaveToKnowledge = async (fileId: string, title: string) => {
    setError(null);
    try {
      const res = await apiClient.saveCreatorFileToKnowledge(fileId, { title });
      setNotice(`Indexed "${res.title}" into Knowledge Base (${res.chunk_count} FTS5 chunks).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to index file into Knowledge Base.');
    }
  };

  const handleDispatchAgent = async (fileId: string, agentId: string, goal: string) => {
    setError(null);
    try {
      const detail = await apiClient.dispatchCreatorFileToAgent(fileId, { agent_id: agentId, goal });
      setNotice(
        `Dispatched to Agent OS: "${detail.task.title}" (${detail.steps.length} steps planned, awaiting operator review in Agent OS).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch task to Agent OS.');
    }
  };

  const handleCreateProject = async (payload: {
    name: string;
    description: string;
    workspace_type: string;
    linked_research_id: string | null;
  }) => {
    setError(null);
    try {
      const created = await apiClient.createCreatorProject(payload);
      const list = await apiClient.listCreatorProjects();
      setProjects(list);
      setSelectedProjectId(created.id);
      await loadFiles(created.id);
      setNotice(`Created project "${created.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project.');
    }
  };

  const handleUpdateProject = async (
    id: string,
    payload: { name?: string; description?: string; linked_research_id?: string | null }
  ) => {
    setError(null);
    try {
      const updated = await apiClient.updateCreatorProject(id, payload);
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...updated } : p)));
      setNotice(`Updated project "${updated.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project.');
    }
  };

  const handleDeleteProject = (proj: CreatorProject) => {
    setConfirmDialog({
      title: 'Delete Creator Project?',
      message: `Delete "${proj.name}" and all its stored workspace files and revision history? This action cannot be undone.`,
      confirmLabel: 'Delete Project',
      tone: 'danger',
      onConfirm: async () => {
        await apiClient.deleteCreatorProject(proj.id);
        const list = await apiClient.listCreatorProjects();
        setProjects(list);
        const nextId = list[0]?.id || '';
        setSelectedProjectId(nextId);
        await loadFiles(nextId);
        setNotice(`Deleted project "${proj.name}".`);
      },
    });
  };

  const handleDeleteFile = (file: CreatorProjectFile) => {
    setConfirmDialog({
      title: 'Delete Workspace File?',
      message: `Delete "${file.filename}" and its revision history from "${activeProject?.name || 'project'}"?`,
      confirmLabel: 'Delete File',
      tone: 'danger',
      onConfirm: async () => {
        await apiClient.deleteCreatorFile(file.id);
        if (activeProject) await loadFiles(activeProject.id);
        setNotice(`Deleted "${file.filename}".`);
      },
    });
  };

  const handleRestoreRevision = (file: CreatorProjectFile, rev: CreatorRevision) => {
    setConfirmDialog({
      title: `Restore ${file.filename} to v${rev.version}?`,
      message: `Confirm restoring "${file.filename}" to revision v${rev.version}. Current contents will remain archived in the revision log.`,
      confirmLabel: `Restore v${rev.version}`,
      tone: 'warning',
      onConfirm: async () => {
        const restored = await apiClient.restoreCreatorRevision(file.id, rev.id);
        if (activeProject) await loadFiles(activeProject.id);
        setActiveFileId(restored.id);
        setNotice(`Restored "${restored.filename}" from v${rev.version} (now v${restored.version}).`);
      },
    });
  };

  const handleOpenFileInWorkspace = (file: CreatorProjectFile) => {
    setActiveFileId(file.id);
    if (file.kind === 'code') setActiveTab('coding');
    else if (file.kind === 'presentation') setActiveTab('presentations');
    else setActiveTab('documents');
  };

  const tabs: Array<{ id: CreatorWorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'coding', label: 'Coding', icon: Code2 },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'presentations', label: 'Presentations', icon: Presentation },
    { id: 'projects', label: 'Projects', icon: FolderKanban },
  ];

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-7xl mx-auto space-y-5">
        {/* Studio Header & Workspace Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Genesis Creator Studio
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">
              Coding Studio, Document Authoring (.docx/.pdf/.md/.txt), Presentations (.pptx), and Revision-Tracked Projects.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {projects.length > 0 && (
              <select
                value={selectedProjectId}
                onChange={(e) => {
                  const found = projects.find((p) => p.id === e.target.value);
                  if (found) void handleSelectProject(found);
                }}
                aria-label="Active Creator project"
                className="px-3 py-2 rounded-lg bg-[#11161F] border border-white/[0.1] text-xs font-medium text-slate-100 focus:outline-none focus:border-blue-500"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Project: {p.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => void loadWorkspaceData()}
              aria-label="Refresh Creator Studio"
              className="p-2 rounded-lg bg-[#11161F] hover:bg-[#161C26] border border-white/[0.1] text-slate-300 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Workspace Navigation Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 rounded-xl bg-[#11161F] border border-white/[0.08]">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                    activeTab === tab.id
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Overwrite confirmation & workspace confinement active</span>
          </div>
        </div>

        {/* Feedback Banners */}
        {error && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            <span className="inline-flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-red-200 hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {notice && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{notice}</span>
            </span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-emerald-200 hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Active Workspace View */}
        {loading && projects.length === 0 ? (
          <div className="p-10 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-xs text-slate-400">
            Loading Creator Studio workspaces...
          </div>
        ) : activeTab === 'coding' ? (
          <CodingWorkspace
            project={activeProject}
            files={files}
            activeFile={activeFile}
            onSelectFile={(f) => setActiveFileId(f.id)}
            onCreateFile={handleCreateFile}
            onSaveFile={handleSaveFile}
            onExportFile={handleExportFile}
            onSaveToMemory={handleSaveToMemory}
            onSaveToKnowledge={handleSaveToKnowledge}
            onDispatchAgent={handleDispatchAgent}
            researchList={researchList}
            labItems={labItems}
            agents={agents}
          />
        ) : activeTab === 'documents' ? (
          <DocumentWorkspace
            project={activeProject}
            files={files}
            activeFile={activeFile}
            onSelectFile={(f) => setActiveFileId(f.id)}
            onCreateFile={handleCreateFile}
            onSaveFile={handleSaveFile}
            onUploadFile={handleUploadFile}
            onExportFile={handleExportFile}
            onSaveToMemory={handleSaveToMemory}
            onSaveToKnowledge={handleSaveToKnowledge}
            onDispatchAgent={handleDispatchAgent}
            researchList={researchList}
            labItems={labItems}
            agents={agents}
          />
        ) : activeTab === 'presentations' ? (
          <PresentationWorkspace
            project={activeProject}
            files={files}
            activeFile={activeFile}
            onSelectFile={(f) => setActiveFileId(f.id)}
            onCreateFile={handleCreateFile}
            onSaveFile={handleSaveFile}
            onUploadFile={handleUploadFile}
            onUploadImageAsset={handleUploadImageAsset}
            onExportDeck={handleExportDeck}
            onSaveToMemory={handleSaveToMemory}
            onSaveToKnowledge={handleSaveToKnowledge}
            onDispatchAgent={handleDispatchAgent}
            researchList={researchList}
            labItems={labItems}
            agents={agents}
          />
        ) : (
          <ProjectsWorkspace
            projects={projects}
            activeProject={activeProject}
            files={files}
            researchList={researchList}
            agents={agents}
            onSelectProject={(p) => void handleSelectProject(p)}
            onCreateProject={handleCreateProject}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
            onOpenFileInWorkspace={handleOpenFileInWorkspace}
            onDeleteFile={handleDeleteFile}
            onUploadFile={handleUploadFile}
            onRestoreRevision={handleRestoreRevision}
            onDispatchAgent={handleDispatchAgent}
          />
        )}
      </div>

      {/* Shared Confirmation Dialog (Overwrite / Delete / Restore / Memory Approval) */}
      {confirmDialog && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-white/[0.12] bg-[#11161F] p-6 space-y-4 shadow-2xl">
            <h3 className="font-display text-base font-semibold text-slate-100">
              {confirmDialog.title}
            </h3>
            <p className="text-xs leading-relaxed text-slate-300">{confirmDialog.message}</p>
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={confirmBusy}
                onClick={() => setConfirmDialog(null)}
                className="px-3.5 py-2 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmBusy}
                onClick={async () => {
                  setConfirmBusy(true);
                  try {
                    await confirmDialog.onConfirm();
                    setConfirmDialog(null);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Action failed.');
                    setConfirmDialog(null);
                  } finally {
                    setConfirmBusy(false);
                  }
                }}
                className={`px-4 py-2 rounded-lg text-xs font-medium text-white cursor-pointer ${
                  confirmDialog.tone === 'danger'
                    ? 'bg-red-600 hover:bg-red-500'
                    : confirmDialog.tone === 'warning'
                      ? 'bg-amber-600 hover:bg-amber-500'
                      : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {confirmBusy ? 'Working...' : confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
