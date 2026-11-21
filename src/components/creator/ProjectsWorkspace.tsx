import React, { useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  FolderKanban,
  FolderPlus,
  History,
  Layers,
  Plus,
  RotateCcw,
  Save,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  AgentBlueprint,
  CreatorArtifact,
  CreatorProject,
  CreatorProjectFile,
  CreatorRevision,
  ResearchProject,
} from '../../types/genesis';

interface ProjectsWorkspaceProps {
  projects: CreatorProject[];
  activeProject: CreatorProject | null;
  files: CreatorProjectFile[];
  researchList: ResearchProject[];
  agents: AgentBlueprint[];
  onSelectProject: (project: CreatorProject) => void;
  onCreateProject: (payload: {
    name: string;
    description: string;
    workspace_type: string;
    linked_research_id: string | null;
  }) => Promise<void>;
  onUpdateProject: (
    id: string,
    payload: { name?: string; description?: string; linked_research_id?: string | null }
  ) => Promise<void>;
  onDeleteProject: (project: CreatorProject) => void;
  onOpenFileInWorkspace: (file: CreatorProjectFile) => void;
  onDeleteFile: (file: CreatorProjectFile) => void;
  onUploadFile: (filename: string, encoding: 'utf8' | 'base64', data: string) => Promise<void>;
  onRestoreRevision: (file: CreatorProjectFile, rev: CreatorRevision) => void;
  onDispatchAgent: (fileId: string, agentId: string, goal: string) => Promise<void>;
}

export const ProjectsWorkspace: React.FC<ProjectsWorkspaceProps> = ({
  projects,
  activeProject,
  files,
  researchList,
  agents,
  onSelectProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onOpenFileInWorkspace,
  onDeleteFile,
  onUploadFile,
  onRestoreRevision,
  onDispatchAgent,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceType, setWorkspaceType] = useState<'mixed' | 'coding' | 'documents' | 'presentations'>('mixed');
  const [linkedResearchId, setLinkedResearchId] = useState('');
  const [creating, setCreating] = useState(false);

  const [historyFile, setHistoryFile] = useState<CreatorProjectFile | null>(null);
  const [revisions, setRevisions] = useState<CreatorRevision[]>([]);
  const [loadingRevs, setLoadingRevs] = useState(false);

  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.id || 'agent-task-operator');
  const [legacyArtifacts, setLegacyArtifacts] = useState<CreatorArtifact[]>([]);
  const [showLegacy, setShowLegacy] = useState(false);
  const [legacyTitle, setLegacyTitle] = useState('');
  const [legacyContent, setLegacyContent] = useState('');

  const uploadRef = useRef<HTMLInputElement | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await onCreateProject({
        name: name.trim(),
        description: description.trim(),
        workspace_type: workspaceType,
        linked_research_id: linkedResearchId || null,
      });
      setName('');
      setDescription('');
      setLinkedResearchId('');
    } finally {
      setCreating(false);
    }
  };

  const loadHistory = async (file: CreatorProjectFile) => {
    setHistoryFile(file);
    setLoadingRevs(true);
    try {
      const list = await apiClient.listCreatorRevisions(file.id);
      setRevisions(list);
    } finally {
      setLoadingRevs(false);
    }
  };

  const handleFileUploadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.toLowerCase().split('.').pop() || '';
    const isBinary = ['docx', 'pptx', 'png', 'jpg', 'jpeg'].includes(ext);
    const reader = new FileReader();
    reader.onload = () => {
      if (isBinary && reader.result instanceof ArrayBuffer) {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        void onUploadFile(file.name, 'base64', btoa(binary));
      } else if (typeof reader.result === 'string') {
        void onUploadFile(file.name, 'utf8', reader.result);
      }
    };
    if (isBinary) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
    e.target.value = '';
  };

  const toggleLegacy = async () => {
    const next = !showLegacy;
    setShowLegacy(next);
    if (next && legacyArtifacts.length === 0) {
      const list = await apiClient.listCreator();
      setLegacyArtifacts(list);
    }
  };

  const handleCreateLegacy = async () => {
    if (!legacyTitle.trim()) return;
    const created = await apiClient.createArtifact({
      title: legacyTitle.trim(),
      artifact_type: 'markdown',
      language: 'markdown',
      content: legacyContent || '# Blueprint\n',
    });
    setLegacyArtifacts((prev) => [created, ...prev]);
    setLegacyTitle('');
    setLegacyContent('');
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Project List & Create Form */}
        <div className="lg:col-span-5 space-y-4">
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
              <FolderPlus className="w-4 h-4 text-blue-400" />
              <span>Create Creator Project</span>
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name (e.g., Windows Edge Agent Kit)"
              className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none focus:border-blue-500"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description..."
              className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 focus:outline-none"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={workspaceType}
                onChange={(e) =>
                  setWorkspaceType(e.target.value as 'mixed' | 'coding' | 'documents' | 'presentations')
                }
                className="px-2.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
              >
                <option value="mixed">Mixed Studio</option>
                <option value="coding">Coding</option>
                <option value="documents">Documents</option>
                <option value="presentations">Presentations</option>
              </select>
              <select
                value={linkedResearchId}
                onChange={(e) => setLinkedResearchId(e.target.value)}
                className="px-2.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
              >
                <option value="">Link Research (optional)</option>
                {researchList.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{creating ? 'Creating...' : 'Create Project'}</span>
            </button>
          </form>

          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
              <FolderKanban className="w-4 h-4 text-blue-400" />
              <span>Projects ({projects.length})</span>
            </div>
            <div className="space-y-2">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`p-3 rounded-xl border transition-colors ${
                    activeProject?.id === p.id
                      ? 'bg-[#161F2D] border-blue-500/50'
                      : 'bg-[#0A0D12] border-white/[0.06]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectProject(p)}
                      className="flex-1 text-left cursor-pointer"
                    >
                      <div className="text-sm font-semibold text-slate-100">{p.name}</div>
                      {p.description && (
                        <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">{p.description}</div>
                      )}
                      <div className="text-[11px] text-slate-500 mt-1.5">
                        {p.workspace_type} · {p.file_count ?? 0} files
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteProject(p)}
                      aria-label={`Delete project ${p.name}`}
                      className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Active Project Files, Upload & Revisions */}
        <div className="lg:col-span-7 space-y-4">
          {activeProject ? (
            <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/[0.08]">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    {activeProject.name}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Upload supported code, documents (.md, .txt, .docx), presentations (.pptx), or validated PNG/JPEG assets.
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => uploadRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Upload File</span>
                  </button>
                  <input
                    ref={uploadRef}
                    type="file"
                    accept=".py,.js,.ts,.tsx,.html,.css,.c,.cpp,.md,.markdown,.txt,.json,.docx,.pptx,.png,.jpg,.jpeg"
                    onChange={handleFileUploadInput}
                    className="hidden"
                  />
                </div>
              </div>

              {/* Linked Research Study selector */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-slate-400">Linked Research Study:</span>
                <select
                  value={activeProject.linked_research_id || ''}
                  onChange={(e) =>
                    void onUpdateProject(activeProject.id, {
                      linked_research_id: e.target.value || null,
                    })
                  }
                  className="px-2.5 py-1 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
                >
                  <option value="">None</option>
                  {researchList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
              </div>

              {/* Files Table */}
              <div className="space-y-2">
                {files.length === 0 ? (
                  <div className="p-6 rounded-lg bg-[#0A0D12] border border-white/[0.06] text-center text-xs text-slate-500">
                    This project has no files yet. Upload a file or create one in Coding, Documents, or Presentations.
                  </div>
                ) : (
                  files.map((f) => (
                    <div
                      key={f.id}
                      className="p-3 rounded-xl bg-[#0A0D12] border border-white/[0.08] flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-xs font-medium text-slate-100 truncate">
                          {f.filename}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                          {f.kind} · {f.format} · v{f.version} · {new Date(f.updated_at).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenFileInWorkspace(f)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-blue-300 cursor-pointer"
                        >
                          <span>Open</span>
                          <ArrowRight className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void loadHistory(f)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-300 cursor-pointer"
                        >
                          <History className="w-3 h-3" />
                          <span>History</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void onDispatchAgent(
                              f.id,
                              selectedAgent,
                              `Review Creator file ${f.filename} (${f.kind}) and write an executive workspace brief.`
                            )
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-indigo-300 cursor-pointer"
                        >
                          <Send className="w-3 h-3" />
                          <span>Agent</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteFile(f)}
                          aria-label={`Delete file ${f.filename}`}
                          className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {files.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-slate-400 pt-1">
                  <span>Agent OS dispatch blueprint:</span>
                  <select
                    value={selectedAgent}
                    onChange={(e) => setSelectedAgent(e.target.value)}
                    className="px-2.5 py-1 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Revision History Viewer */}
              {historyFile && (
                <div className="rounded-xl border border-blue-500/30 bg-[#0A0D12] p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-slate-200">
                      Revision History: <span className="font-mono text-blue-300">{historyFile.filename}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setHistoryFile(null)}
                      className="text-xs text-slate-500 hover:text-slate-200 cursor-pointer"
                    >
                      Close
                    </button>
                  </div>

                  {loadingRevs ? (
                    <div className="text-xs text-slate-500">Loading revisions...</div>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {revisions.map((rev) => (
                        <div
                          key={rev.id}
                          className="p-2.5 rounded-lg bg-[#11161F] border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <span className="font-semibold text-slate-200">v{rev.version}</span> ·{' '}
                            <span className="text-slate-300">{rev.summary}</span>
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {new Date(rev.created_at).toLocaleString()} · {rev.content.length} chars
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => onRestoreRevision(historyFile, rev)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-amber-300 cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Restore</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-8 rounded-xl border border-white/[0.08] bg-[#11161F] text-center text-xs text-slate-400">
              Select or create a Creator Studio project to manage files and revisions.
            </div>
          )}
        </div>
      </div>

      {/* Preserved Step 01 Legacy Artifacts Section */}
      <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3">
        <button
          type="button"
          onClick={() => void toggleLegacy()}
          className="w-full flex items-center justify-between text-xs font-semibold text-slate-300 cursor-pointer"
        >
          <span className="inline-flex items-center gap-2">
            <Layers className="w-4 h-4 text-slate-400" />
            <span>Legacy Single-File Blueprints (Step 01 Artifact Store)</span>
          </span>
          <span className="text-slate-500">{showLegacy ? 'Hide' : 'Expand'}</span>
        </button>

        {showLegacy && (
          <div className="space-y-3 pt-2 border-t border-white/[0.08]">
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={legacyTitle}
                onChange={(e) => setLegacyTitle(e.target.value)}
                placeholder="New legacy artifact title"
                className="px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
              />
              <input
                type="text"
                value={legacyContent}
                onChange={(e) => setLegacyContent(e.target.value)}
                placeholder="Markdown / code snippet..."
                className="flex-1 px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
              />
              <button
                type="button"
                onClick={() => void handleCreateLegacy()}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-xs text-white cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Add Artifact</span>
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {legacyArtifacts.map((art) => (
                <div
                  key={art.id}
                  className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08] flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-200 truncate">{art.title}</div>
                    <div className="text-[11px] text-slate-500">
                      {art.artifact_type} · {art.language} · v{art.version}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await apiClient.deleteArtifact(art.id);
                      setLegacyArtifacts((prev) => prev.filter((x) => x.id !== art.id));
                    }}
                    className="p-1 text-slate-500 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
