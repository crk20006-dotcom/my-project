import React, { useMemo, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Database,
  Download,
  Eye,
  FileText,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Pencil,
  Plus,
  Quote,
  Save,
  Send,
  Table2,
  Upload,
  Code,
  Minus,
} from 'lucide-react';
import type {
  AgentBlueprint,
  CreatorProject,
  CreatorProjectFile,
  LaboratoryItem,
  ResearchProject,
} from '../../types/genesis';
import { CreatorAssistPanel } from './CreatorAssistPanel';

interface DocumentWorkspaceProps {
  project: CreatorProject | null;
  files: CreatorProjectFile[];
  activeFile: CreatorProjectFile | null;
  onSelectFile: (file: CreatorProjectFile) => void;
  onCreateFile: (payload: { filename: string; kind: 'document'; format: string; content: string }) => Promise<void>;
  onSaveFile: (fileId: string, payload: { filename?: string; format?: string; content: string; summary?: string }) => Promise<void>;
  onUploadFile: (filename: string, encoding: 'utf8' | 'base64', data: string) => Promise<void>;
  onExportFile: (payload: { title: string; filename?: string; format: string; content: string; saveToWorkspace: boolean }) => Promise<void>;
  onSaveToMemory: (fileId: string, title: string) => void;
  onSaveToKnowledge: (fileId: string, title: string) => Promise<void>;
  onDispatchAgent: (fileId: string, agentId: string, goal: string) => Promise<void>;
  researchList: ResearchProject[];
  labItems: LaboratoryItem[];
  agents: AgentBlueprint[];
}

type PreviewBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'code'; language: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'divider' };

function isSeparatorLine(line: string): boolean {
  const cleaned = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return cleaned.includes('-') && cleaned.split('|').every((p) => /^\s*:?-{2,}:?\s*$/.test(p));
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function parsePreviewBlocks(md: string): PreviewBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: PreviewBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', language: lang, text: buf.join('\n') });
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: 'divider' });
      i += 1;
      continue;
    }
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        q.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: q.join(' ') });
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const headers = splitCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && !isSeparatorLine(lines[i])) {
        rows.push(splitCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const c = lines[i].trim();
        if (ordered && /^\d+\.\s+/.test(c)) {
          items.push(c.replace(/^\d+\.\s+/, ''));
          i += 1;
        } else if (!ordered && /^[-*]\s+/.test(c)) {
          items.push(c.replace(/^[-*]\s+/, ''));
          i += 1;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|```|[-*]\s|\d+\.\s|>|---+$)/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }
  return blocks;
}

export const DocumentWorkspace: React.FC<DocumentWorkspaceProps> = ({
  project,
  files,
  activeFile,
  onSelectFile,
  onCreateFile,
  onSaveFile,
  onUploadFile,
  onExportFile,
  onSaveToMemory,
  onSaveToKnowledge,
  onDispatchAgent,
  researchList,
  labItems,
  agents,
}) => {
  const docFiles = useMemo(() => files.filter((f) => f.kind === 'document'), [files]);
  const [titleInput, setTitleInput] = useState(
    activeFile?.filename.replace(/\.(md|txt)$/i, '') || 'architecture_brief'
  );
  const [draft, setDraft] = useState(
    activeFile?.content ||
      '# Project Genesis Specification\n\n## Overview\n\nAuthor structured documents, tables, and lists for export to Word (.docx), PDF (.pdf), Markdown (.md), or Text (.txt).\n\n| Module | Storage | Export |\n| --- | --- | --- |\n| Creator Studio | SQLite | DOCX / PDF |\n'
  );
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');
  const [newFilename, setNewFilename] = useState('');
  const [newFormat, setNewFormat] = useState<'md' | 'txt'>('md');
  const [saveExportCopy, setSaveExportCopy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.id || 'agent-task-operator');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (activeFile && activeFile.kind === 'document') {
      setTitleInput(activeFile.filename.replace(/\.(md|txt)$/i, ''));
      setDraft(activeFile.content);
    }
  }, [activeFile?.id, activeFile?.version]);

  const previewBlocks = useMemo(() => parsePreviewBlocks(draft), [draft]);

  const insertSnippet = (snippet: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setDraft((prev) => `${prev}\n${snippet}`);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = draft.slice(0, start) + snippet + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + snippet.length;
    });
  };

  const handleCreateDoc = async () => {
    const raw = (newFilename.trim() || 'technical_note').replace(/\.(md|txt)$/i, '');
    const fname = `${raw}.${newFormat}`;
    await onCreateFile({
      filename: fname,
      kind: 'document',
      format: newFormat === 'md' ? 'markdown' : 'txt',
      content: `# ${raw}\n\n## Summary\n\n- Key item 1\n- Key item 2\n`,
    });
    setNewFilename('');
  };

  const handleSaveDoc = async () => {
    if (!project) return;
    setSaving(true);
    try {
      if (activeFile && activeFile.kind === 'document') {
        await onSaveFile(activeFile.id, {
          content: draft,
          summary: `Edited ${activeFile.filename}`,
        });
      } else {
        const safeBase = (titleInput.trim() || 'document').replace(/[^a-zA-Z0-9._-]+/g, '_');
        await onCreateFile({
          filename: `${safeBase}.md`,
          kind: 'document',
          format: 'markdown',
          content: draft,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleImportUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isBinaryDocx = file.name.toLowerCase().endsWith('.docx');
    const reader = new FileReader();
    reader.onload = () => {
      if (isBinaryDocx && reader.result instanceof ArrayBuffer) {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        void onUploadFile(file.name, 'base64', btoa(binary));
      } else if (typeof reader.result === 'string') {
        void onUploadFile(file.name, 'utf8', reader.result);
      }
    };
    if (isBinaryDocx) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left Sidebar: Documents in Project */}
      <div className="lg:col-span-3 space-y-4">
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-slate-300">
              Documents ({docFiles.length})
            </h3>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-[11px] text-slate-300 cursor-pointer"
            >
              <Upload className="w-3 h-3" />
              <span>Import</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,.docx"
              onChange={handleImportUpload}
              className="hidden"
            />
          </div>

          <div className="flex gap-1.5">
            <input
              type="text"
              value={newFilename}
              onChange={(e) => setNewFilename(e.target.value)}
              placeholder="new_doc"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200 focus:outline-none"
            />
            <select
              value={newFormat}
              onChange={(e) => setNewFormat(e.target.value as 'md' | 'txt')}
              className="px-2 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
            >
              <option value="md">.md</option>
              <option value="txt">.txt</option>
            </select>
            <button
              type="button"
              onClick={() => void handleCreateDoc()}
              aria-label="Create document"
              className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {docFiles.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onSelectFile(f)}
                className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                  activeFile?.id === f.id
                    ? 'bg-[#161F2D] border-blue-500/50 text-slate-100'
                    : 'bg-[#0A0D12] border-white/[0.06] text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono truncate">{f.filename}</span>
                  <span className="text-[10px] text-slate-500 shrink-0">v{f.version}</span>
                </div>
              </button>
            ))}
            {docFiles.length === 0 && (
              <p className="text-xs text-slate-500 py-2">No documents in this project yet.</p>
            )}
          </div>
        </div>

        <CreatorAssistPanel
          workspace="documents"
          title={titleInput}
          content={draft}
          researchList={researchList}
          labItems={labItems}
          defaultResearchId={project?.linked_research_id}
          actions={[
            { id: 'draft', label: 'Draft Structured Document' },
            { id: 'summarize', label: 'Executive Summary & Table' },
          ]}
          onApplyDraft={(next) => setDraft(next)}
        />
      </div>

      {/* Main Editor + Formatted Preview */}
      <div className="lg:col-span-9 space-y-4">
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <FileText className="w-4 h-4 text-blue-400 shrink-0" />
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                aria-label="Document title"
                className="flex-1 px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm font-medium text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
              {(['split', 'edit', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs cursor-pointer capitalize ${
                    viewMode === m ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {m === 'edit' && <Pencil className="w-3 h-3" />}
                  {m === 'preview' && <Eye className="w-3 h-3" />}
                  <span>{m}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void handleSaveDoc()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Saving...' : 'Save Revision'}</span>
            </button>
          </div>

          {/* Formatting Toolbar */}
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-white/[0.06]">
            {[
              { label: 'H1', icon: Heading1, snippet: '\n# Section Title\n' },
              { label: 'H2', icon: Heading2, snippet: '\n## Subsection\n' },
              { label: 'List', icon: List, snippet: '\n- Bullet point\n- Second item\n' },
              { label: 'Numbered', icon: ListOrdered, snippet: '\n1. Step one\n2. Step two\n' },
              {
                label: 'Table',
                icon: Table2,
                snippet: '\n| Component | Role | Status |\n| --- | --- | --- |\n| Engine | Local | Ready |\n',
              },
              { label: 'Code', icon: Code, snippet: '\n```python\nprint("Project Genesis")\n```\n' },
              { label: 'Quote', icon: Quote, snippet: '\n> Key architectural note.\n' },
              { label: 'Divider', icon: Minus, snippet: '\n---\n' },
            ].map((btn) => {
              const Icon = btn.icon;
              return (
                <button
                  key={btn.label}
                  type="button"
                  onClick={() => insertSnippet(btn.snippet)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#0A0D12] hover:bg-[#161C26] border border-white/[0.08] text-xs text-slate-300 cursor-pointer"
                >
                  <Icon className="w-3.5 h-3.5 text-slate-400" />
                  <span>{btn.label}</span>
                </button>
              );
            })}
          </div>

          {/* Editor / Preview Grid */}
          <div className={`grid gap-4 ${viewMode === 'split' ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'}`}>
            {(viewMode === 'split' || viewMode === 'edit') && (
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={18}
                aria-label="Document Markdown editor"
                className="w-full h-[420px] px-4 py-3 rounded-lg bg-[#080B10] border border-white/[0.08] font-mono text-[13px] leading-relaxed text-slate-100 focus:outline-none focus:border-blue-500 resize-none"
              />
            )}

            {(viewMode === 'split' || viewMode === 'preview') && (
              <div className="h-[420px] overflow-y-auto px-5 py-4 rounded-lg bg-[#0A0D12] border border-white/[0.08] space-y-3">
                {previewBlocks.map((b, idx) => {
                  if (b.type === 'heading') {
                    const cls =
                      b.level === 1
                        ? 'text-xl font-bold text-slate-100 border-b border-white/[0.08] pb-1.5'
                        : b.level === 2
                          ? 'text-base font-semibold text-blue-300 pt-1'
                          : 'text-sm font-semibold text-slate-200';
                    return (
                      <div key={idx} className={cls}>
                        {b.text}
                      </div>
                    );
                  }
                  if (b.type === 'paragraph') {
                    return (
                      <p key={idx} className="text-[13.5px] leading-relaxed text-slate-300">
                        {b.text}
                      </p>
                    );
                  }
                  if (b.type === 'quote') {
                    return (
                      <blockquote
                        key={idx}
                        className="pl-3 border-l-2 border-blue-500 text-[13px] italic text-slate-400"
                      >
                        {b.text}
                      </blockquote>
                    );
                  }
                  if (b.type === 'list') {
                    return b.ordered ? (
                      <ol key={idx} className="list-decimal pl-5 space-y-1 text-[13.5px] text-slate-300">
                        {b.items.map((item, ii) => (
                          <li key={ii}>{item}</li>
                        ))}
                      </ol>
                    ) : (
                      <ul key={idx} className="list-disc pl-5 space-y-1 text-[13.5px] text-slate-300">
                        {b.items.map((item, ii) => (
                          <li key={ii}>{item}</li>
                        ))}
                      </ul>
                    );
                  }
                  if (b.type === 'table') {
                    return (
                      <div key={idx} className="overflow-x-auto rounded-lg border border-white/[0.1]">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead className="bg-[#141B26] text-slate-200">
                            <tr>
                              {b.headers.map((h, hi) => (
                                <th key={hi} className="px-3 py-2 border-b border-white/[0.1] font-semibold">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {b.rows.map((row, ri) => (
                              <tr key={ri} className="border-b border-white/[0.06] last:border-b-0">
                                {b.headers.map((_, ci) => (
                                  <td key={ci} className="px-3 py-1.5 text-slate-300">
                                    {row[ci] || ''}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  }
                  if (b.type === 'code') {
                    return (
                      <pre
                        key={idx}
                        className="p-3 rounded-lg bg-[#11161F] border border-white/[0.08] font-mono text-xs text-slate-200 overflow-x-auto"
                      >
                        {b.text}
                      </pre>
                    );
                  }
                  return <hr key={idx} className="border-white/[0.1]" />;
                })}
              </div>
            )}
          </div>

          {/* Export & Cross-Module Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/[0.08]">
            <div className="flex flex-wrap items-center gap-2">
              {(['docx', 'pdf', 'md', 'txt'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() =>
                    void onExportFile({
                      title: titleInput || 'genesis_document',
                      filename: titleInput || 'genesis_document',
                      format: fmt,
                      content: draft,
                      saveToWorkspace: saveExportCopy,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-blue-400" />
                  <span>Export .{fmt}</span>
                </button>
              ))}
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-400 ml-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveExportCopy}
                  onChange={(e) => setSaveExportCopy(e.target.checked)}
                />
                <span>Also save to workspace disk</span>
              </label>
            </div>

            {activeFile && activeFile.kind === 'document' && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSaveToMemory(activeFile.id, titleInput || activeFile.filename)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-emerald-300 cursor-pointer"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>Save Memory</span>
                </button>
                <button
                  type="button"
                  onClick={() => void onSaveToKnowledge(activeFile.id, titleInput || activeFile.filename)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-cyan-300 cursor-pointer"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>Index KB</span>
                </button>
                <select
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="px-2 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-300"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    void onDispatchAgent(
                      activeFile.id,
                      selectedAgent,
                      `Review document ${activeFile.filename} and prepare a structured workspace summary.`
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-indigo-300 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send to Agent</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
