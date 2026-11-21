import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  Bug,
  CheckCircle2,
  Database,
  Download,
  FileCode2,
  Info,
  Play,
  Plus,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  AgentBlueprint,
  CodeAnalysisResult,
  CreatorProject,
  CreatorProjectFile,
  LaboratoryItem,
  ResearchProject,
  RestrictedCodeRunResult,
  SupportedCodeLanguage,
} from '../../types/genesis';
import { CodeHighlightEditor } from './CodeHighlightEditor';
import { CreatorAssistPanel } from './CreatorAssistPanel';

const LANGUAGE_EXT: Record<SupportedCodeLanguage, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  html: 'html',
  css: 'css',
  c: 'c',
  cpp: 'cpp',
};

const STARTER_SNIPPETS: Record<SupportedCodeLanguage, string> = {
  python: `"""Genesis Data Pipeline — Local Python Module."""
from dataclasses import dataclass


@dataclass
class BuildMetric:
    name: str
    score: float


def summarize(items: list[BuildMetric]) -> float:
    if not items:
        return 0.0
    return sum(item.score for item in items) / len(items)
`,
  javascript: `// Genesis Local Runner — JavaScript Module
function computeScores(values) {
  if (!Array.isArray(values) || values.length === 0) return { count: 0, total: 0 };
  const total = values.reduce((acc, n) => acc + Number(n || 0), 0);
  return { count: values.length, total, average: Number((total / values.length).toFixed(2)) };
}

const summary = computeScores([12, 18, 24, 30]);
console.log("Summary:", JSON.stringify(summary));
summary;
`,
  typescript: `// Genesis Typed Adapter — TypeScript
export interface TelemetryPoint {
  label: string;
  value: number;
}

export function normalizePoints(points: TelemetryPoint[]): TelemetryPoint[] {
  return points.map((p) => ({ label: p.label.trim(), value: Math.max(0, p.value) }));
}
`,
  html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Genesis Prototype</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    .panel { max-width: 620px; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; background: #1e293b; }
  </style>
</head>
<body>
  <main class="panel">
    <h1>Project Genesis Creator</h1>
    <p>Sandboxed static HTML prototype preview.</p>
  </main>
</body>
</html>
`,
  css: `/* Genesis Creator Theme Tokens */
:root {
  --surface-0: #0a0d12;
  --surface-1: #11161f;
  --accent-blue: #3b82f6;
}

.genesis-card {
  background: var(--surface-1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}
`,
  c: `/* Genesis Bounded C99 Module */
#include <stdio.h>
#include <string.h>

int main(void) {
    char label[64];
    snprintf(label, sizeof(label), "%s", "Project Genesis C99");
    printf("Initialized: %s\\n", label);
    return 0;
}
`,
  cpp: `// Genesis C++17 Module
#include <iostream>
#include <string>
#include <vector>

int main() {
    std::vector<std::string> steps = {"Analyze", "Refactor", "Export"};
    std::cout << "Genesis stages: " << steps.size() << std::endl;
    return 0;
}
`,
};

interface CodingWorkspaceProps {
  project: CreatorProject | null;
  files: CreatorProjectFile[];
  activeFile: CreatorProjectFile | null;
  onSelectFile: (file: CreatorProjectFile) => void;
  onCreateFile: (payload: { filename: string; kind: 'code'; format: string; content: string }) => Promise<void>;
  onSaveFile: (fileId: string, payload: { filename?: string; format?: string; content: string; summary?: string }) => Promise<void>;
  onExportFile: (payload: { title: string; filename?: string; format: string; content: string; saveToWorkspace: boolean }) => Promise<void>;
  onSaveToMemory: (fileId: string, title: string) => void;
  onSaveToKnowledge: (fileId: string, title: string) => Promise<void>;
  onDispatchAgent: (fileId: string, agentId: string, goal: string) => Promise<void>;
  researchList: ResearchProject[];
  labItems: LaboratoryItem[];
  agents: AgentBlueprint[];
}

export const CodingWorkspace: React.FC<CodingWorkspaceProps> = ({
  project,
  files,
  activeFile,
  onSelectFile,
  onCreateFile,
  onSaveFile,
  onExportFile,
  onSaveToMemory,
  onSaveToKnowledge,
  onDispatchAgent,
  researchList,
  labItems,
  agents,
}) => {
  const codeFiles = useMemo(() => files.filter((f) => f.kind === 'code'), [files]);
  const [language, setLanguage] = useState<SupportedCodeLanguage>(
    (activeFile?.kind === 'code' && (activeFile.format as SupportedCodeLanguage)) || 'python'
  );
  const [filenameInput, setFilenameInput] = useState(
    (activeFile?.kind === 'code' && activeFile.filename) || 'module.py'
  );
  const [code, setCode] = useState(
    (activeFile?.kind === 'code' && activeFile.content) || STARTER_SNIPPETS.python
  );
  const [newName, setNewName] = useState('');
  const [newLang, setNewLang] = useState<SupportedCodeLanguage>('python');
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);

  const [inspectorTab, setInspectorTab] = useState<'analyze' | 'run' | 'assist'>('analyze');
  const [analysis, setAnalysis] = useState<CodeAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const [runResult, setRunResult] = useState<RestrictedCodeRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [sandboxApproved, setSandboxApproved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.id || 'agent-task-operator');

  React.useEffect(() => {
    if (activeFile && activeFile.kind === 'code') {
      const lang = (['python', 'javascript', 'typescript', 'html', 'css', 'c', 'cpp'].includes(
        activeFile.format
      )
        ? activeFile.format
        : 'python') as SupportedCodeLanguage;
      setLanguage(lang);
      setFilenameInput(activeFile.filename);
      setCode(activeFile.content);
      setShowHtmlPreview(false);
      setRunResult(null);
      setRunError(null);
    }
  }, [activeFile?.id, activeFile?.version]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalysisError(null);
    setInspectorTab('analyze');
    try {
      const res = await apiClient.analyzeCreatorCode(language, code);
      setAnalysis(res);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Static analysis failed.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRunSandbox = async () => {
    if (!sandboxApproved) {
      setRunError('Check the approval box first to authorize restricted JavaScript sandbox execution.');
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const res = await apiClient.runCreatorCode(language, code, true);
      setRunResult(res);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Sandbox execution failed.');
    } finally {
      setRunning(false);
    }
  };

  const handleCreateCodeFile = async () => {
    const ext = LANGUAGE_EXT[newLang];
    const base = (newName.trim() || `script_${Date.now() % 1000}`).replace(/\.[^.]+$/, '');
    await onCreateFile({
      filename: `${base}.${ext}`,
      kind: 'code',
      format: newLang,
      content: STARTER_SNIPPETS[newLang],
    });
    setNewName('');
  };

  const handleSaveCode = async () => {
    if (!project) return;
    setSaving(true);
    try {
      if (activeFile && activeFile.kind === 'code') {
        await onSaveFile(activeFile.id, {
          filename: filenameInput,
          format: language,
          content: code,
          summary: `Updated ${filenameInput} (${language})`,
        });
      } else {
        const ext = LANGUAGE_EXT[language];
        const safeName = filenameInput.includes('.') ? filenameInput : `${filenameInput}.${ext}`;
        await onCreateFile({
          filename: safeName,
          kind: 'code',
          format: language,
          content: code,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left Column: Code Files + Main Editor */}
      <div className="lg:col-span-7 space-y-4">
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-blue-400" />
              <span className="font-display text-xs font-semibold uppercase tracking-wider text-slate-300">
                Code Files ({codeFiles.length})
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="new_module"
                className="w-32 px-2.5 py-1 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200 focus:outline-none"
              />
              <select
                value={newLang}
                onChange={(e) => setNewLang(e.target.value as SupportedCodeLanguage)}
                className="px-2 py-1 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
              >
                <option value="python">Python</option>
                <option value="javascript">JavaScript</option>
                <option value="typescript">TypeScript</option>
                <option value="html">HTML</option>
                <option value="css">CSS</option>
                <option value="c">C</option>
                <option value="cpp">C++</option>
              </select>
              <button
                type="button"
                onClick={() => void handleCreateCodeFile()}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {codeFiles.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onSelectFile(f)}
                className={`px-2.5 py-1 rounded-lg border font-mono text-xs cursor-pointer transition-colors ${
                  activeFile?.id === f.id
                    ? 'bg-[#161F2D] border-blue-500/50 text-slate-100'
                    : 'bg-[#0A0D12] border-white/[0.08] text-slate-400 hover:text-slate-200'
                }`}
              >
                {f.filename} <span className="text-[10px] text-slate-500">v{f.version}</span>
              </button>
            ))}
          </div>

          {/* Active File Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 pt-2 border-t border-white/[0.06]">
            <input
              type="text"
              value={filenameInput}
              onChange={(e) => setFilenameInput(e.target.value)}
              aria-label="Code filename"
              className="sm:col-span-5 px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
            />
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as SupportedCodeLanguage)}
              aria-label="Programming language"
              className="sm:col-span-3 px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
            >
              <option value="python">Python</option>
              <option value="javascript">JavaScript</option>
              <option value="typescript">TypeScript</option>
              <option value="html">HTML</option>
              <option value="css">CSS</option>
              <option value="c">C</option>
              <option value="cpp">C++</option>
            </select>
            <button
              type="button"
              onClick={() => setCode(STARTER_SNIPPETS[language])}
              className="sm:col-span-2 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-300 cursor-pointer"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Template</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSaveCode()}
              disabled={saving}
              className="sm:col-span-2 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Saving' : 'Save'}</span>
            </button>
          </div>

          <CodeHighlightEditor
            language={language}
            value={code}
            onChange={setCode}
            showHtmlPreview={showHtmlPreview}
            onToggleHtmlPreview={() => setShowHtmlPreview((v) => !v)}
          />

          {/* File Actions Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleAnalyze()}
                disabled={analyzing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                <Bug className="w-3.5 h-3.5" />
                <span>{analyzing ? 'Analyzing...' : 'Explain & Debug'}</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  void onExportFile({
                    title: filenameInput.replace(/\.[^.]+$/, '') || 'source',
                    filename: filenameInput,
                    format: LANGUAGE_EXT[language],
                    content: code,
                    saveToWorkspace: false,
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .{LANGUAGE_EXT[language]}</span>
              </button>
            </div>

            {activeFile && activeFile.kind === 'code' && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onSaveToMemory(activeFile.id, `Code: ${activeFile.filename}`)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-emerald-300 cursor-pointer"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>Memory</span>
                </button>
                <button
                  type="button"
                  onClick={() => void onSaveToKnowledge(activeFile.id, activeFile.filename)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-cyan-300 cursor-pointer"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>KB</span>
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
                      `Inspect ${activeFile.filename} (${language}) and prepare a code review summary document.`
                    )
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-indigo-300 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Agent</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Column: Diagnostics / Sandbox Runner / Genesis Assist */}
      <div className="lg:col-span-5 space-y-4">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#11161F] border border-white/[0.08]">
          {[
            { id: 'analyze', label: 'Debug & Refactor', icon: Bug },
            { id: 'run', label: 'JS Sandbox Run', icon: Play },
            { id: 'assist', label: 'Genesis Assist', icon: Sparkles },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setInspectorTab(t.id as 'analyze' | 'run' | 'assist')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                  inspectorTab === t.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {inspectorTab === 'analyze' && (
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <h4 className="font-display text-xs font-semibold uppercase tracking-wider text-slate-300">
                Static Diagnostics & Refactoring
              </h4>
              <button
                type="button"
                onClick={() => void handleAnalyze()}
                className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
              >
                Refresh Analysis
              </button>
            </div>

            {analysisError && (
              <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                {analysisError}
              </div>
            )}

            {!analysis ? (
              <div className="p-4 rounded-lg bg-[#0A0D12] border border-white/[0.06] text-xs text-slate-400">
                Click <strong className="text-slate-200">Explain & Debug</strong> to run syntax/delimiter verification, security hygiene checks, symbol extraction, and refactoring guidance for {language.toUpperCase()}.
              </div>
            ) : (
              <div className="space-y-3.5">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded-lg bg-[#0A0D12] border border-white/[0.06]">
                    <div className="text-[11px] text-slate-500">Lines</div>
                    <div className="text-sm font-semibold text-slate-100 tabular-nums">{analysis.metrics.lines}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-[#0A0D12] border border-white/[0.06]">
                    <div className="text-[11px] text-slate-500">Tokens</div>
                    <div className="text-sm font-semibold text-slate-100 tabular-nums">{analysis.metrics.baseline_tokens}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-[#0A0D12] border border-white/[0.06]">
                    <div className="text-[11px] text-slate-500">Max Nesting</div>
                    <div className="text-sm font-semibold text-slate-100 tabular-nums">{analysis.metrics.max_nesting_depth}</div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    Explanation
                  </div>
                  {analysis.explanation.map((line, i) => (
                    <div key={i} className="text-xs text-slate-300 leading-relaxed">
                      · {line}
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    Diagnostics ({analysis.diagnostics.length})
                  </div>
                  {analysis.diagnostics.length === 0 ? (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>No syntax or hygiene issues detected.</span>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {analysis.diagnostics.map((d, i) => (
                        <div
                          key={i}
                          className={`p-2 rounded-lg border text-xs flex items-start gap-2 ${
                            d.severity === 'error'
                              ? 'bg-red-500/10 border-red-500/25 text-red-200'
                              : d.severity === 'warning'
                                ? 'bg-amber-500/10 border-amber-500/25 text-amber-200'
                                : 'bg-[#0A0D12] border-white/[0.08] text-slate-300'
                          }`}
                        >
                          {d.severity === 'info' ? (
                            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-400" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          )}
                          <div>
                            <span className="font-mono text-[11px] opacity-80">L{d.line} [{d.rule}]</span>{' '}
                            {d.message}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    Refactoring Suggestions
                  </div>
                  {analysis.refactoring_suggestions.map((tip, i) => (
                    <div key={i} className="text-xs text-slate-300 leading-relaxed">
                      · {tip}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {inspectorTab === 'run' && (
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3.5">
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-[#0A0D12] border border-amber-500/25 text-xs text-slate-300">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-300">Restricted Sandbox Execution Policy</div>
                <p className="text-slate-400 leading-relaxed">
                  Only isolated JavaScript can execute inside the Node VM sandbox (1200ms CPU limit; no filesystem, network, process, or require access). Python, TypeScript, C, C++, HTML, and CSS are inspected statically and exported cleanly for local compilers.
                </p>
              </div>
            </div>

            {language !== 'javascript' ? (
              <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.08] text-xs text-slate-400">
                Active file language is <strong className="text-slate-200">{language.toUpperCase()}</strong>. Switch to JavaScript to run in the VM sandbox, or use <strong className="text-slate-200">Debug & Refactor</strong> + <strong className="text-slate-200">Download</strong>.
              </div>
            ) : (
              <>
                <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer p-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.08]">
                  <input
                    type="checkbox"
                    checked={sandboxApproved}
                    onChange={(e) => setSandboxApproved(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>I explicitly approve running this JavaScript snippet in the isolated local VM sandbox.</span>
                </label>

                <button
                  type="button"
                  onClick={() => void handleRunSandbox()}
                  disabled={running}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-xs font-medium text-white cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>{running ? 'Running in VM...' : 'Approve & Execute JavaScript'}</span>
                </button>
              </>
            )}

            {runError && (
              <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                {runError}
              </div>
            )}

            {runResult && (
              <div className="p-3 rounded-lg bg-[#080B10] border border-white/[0.08] space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between text-[11px]">
                  <span className={runResult.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {runResult.ok ? 'EXECUTION OK' : 'EXECUTION BLOCKED / FAILED'}
                  </span>
                  <span className="text-slate-500 tabular-nums">{runResult.duration_ms} ms</span>
                </div>
                {runResult.error && <div className="text-red-300">{runResult.error}</div>}
                {runResult.stdout.length > 0 && (
                  <div className="text-slate-300 whitespace-pre-wrap">
                    <div className="text-slate-500 text-[10px] mb-1">STDOUT</div>
                    {runResult.stdout.join('\n')}
                  </div>
                )}
                {runResult.result && (
                  <div className="text-blue-300 whitespace-pre-wrap pt-1 border-t border-white/[0.06]">
                    <div className="text-slate-500 text-[10px] mb-1">RETURN VALUE</div>
                    {runResult.result}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {inspectorTab === 'assist' && (
          <CreatorAssistPanel
            workspace="coding"
            language={language}
            title={filenameInput}
            content={code}
            researchList={researchList}
            labItems={labItems}
            defaultResearchId={project?.linked_research_id}
            actions={[
              { id: 'generate', label: 'Generate Starter Code' },
              { id: 'explain', label: 'Explain Current Code' },
              { id: 'debug', label: 'Debug Errors & Edge Cases' },
              { id: 'refactor', label: 'Refactor & Improve Code' },
            ]}
            onApplyDraft={(nextCode) => setCode(nextCode)}
          />
        )}
      </div>
    </div>
  );
};
