import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  Copy,
  Database,
  Download,
  ImagePlus,
  LayoutTemplate,
  Plus,
  Presentation,
  Save,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AgentBlueprint,
  CreatorProject,
  CreatorProjectFile,
  LaboratoryItem,
  PresentationDeck,
  PresentationSlide,
  PresentationThemeId,
  ResearchProject,
  SlideLayout,
} from '../../types/genesis';
import { CreatorAssistPanel } from './CreatorAssistPanel';

const THEME_STYLES: Record<
  PresentationThemeId,
  { label: string; bg: string; surface: string; border: string; title: string; text: string; accent: string }
> = {
  genesis_dark: {
    label: 'Genesis Dark',
    bg: '#0A0D12',
    surface: '#141B26',
    border: '#2A3548',
    title: '#F1F5F9',
    text: '#CBD5E1',
    accent: '#3B82F6',
  },
  midnight_slate: {
    label: 'Midnight Slate',
    bg: '#0F172A',
    surface: '#1E293B',
    border: '#334155',
    title: '#F8FAFC',
    text: '#E2E8F0',
    accent: '#38BDF8',
  },
  executive_light: {
    label: 'Executive Light',
    bg: '#F8FAFC',
    surface: '#FFFFFF',
    border: '#CBD5E1',
    title: '#0F172A',
    text: '#334155',
    accent: '#2563EB',
  },
  blueprint_blue: {
    label: 'Blueprint Blue',
    bg: '#08182E',
    surface: '#0F2747',
    border: '#1D4ED8',
    title: '#EFF6FF',
    text: '#DBEAFE',
    accent: '#60A5FA',
  },
};

const DEFAULT_DECK: PresentationDeck = {
  title: 'Project Genesis Brief',
  subtitle: 'Local-First AI Operating System',
  author: 'Local Operator',
  theme: 'genesis_dark',
  slides: [
    {
      id: 'slide-1',
      layout: 'title',
      title: 'Project Genesis Creator Studio',
      subtitle: 'Offline-Capable Engineering & Document Platform',
      bullets: ['SQLite Persistence', 'Approval-Gated Workflows', 'OpenXML PPTX Export'],
    },
    {
      id: 'slide-2',
      layout: 'diagram',
      title: 'System Architecture Pipeline',
      subtitle: 'Zero External Paid APIs',
      bullets: ['Browser UI connects to Express API on localhost:3000 with SQLite FTS5 backing.'],
      diagram: {
        kind: 'architecture',
        nodes: [
          { id: 'n1', label: 'Creator UI', role: 'React + TS' },
          { id: 'n2', label: 'Express API', role: 'Validation & Auth' },
          { id: 'n3', label: 'SQLite DB', role: 'Revisions + FTS5' },
        ],
        edges: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3' },
        ],
      },
    },
  ],
};

function parseDeckSafe(raw: string | undefined): PresentationDeck {
  if (!raw) return DEFAULT_DECK;
  try {
    const parsed = JSON.parse(raw) as Partial<PresentationDeck>;
    if (Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return {
        title: parsed.title || 'Untitled Presentation',
        subtitle: parsed.subtitle || '',
        author: parsed.author || 'Local Operator',
        theme: parsed.theme && THEME_STYLES[parsed.theme] ? parsed.theme : 'genesis_dark',
        slides: parsed.slides,
      };
    }
  } catch {
    // Fall back cleanly
  }
  return DEFAULT_DECK;
}

interface PresentationWorkspaceProps {
  project: CreatorProject | null;
  files: CreatorProjectFile[];
  activeFile: CreatorProjectFile | null;
  onSelectFile: (file: CreatorProjectFile) => void;
  onCreateFile: (payload: { filename: string; kind: 'presentation'; format: string; content: string }) => Promise<void>;
  onSaveFile: (fileId: string, payload: { filename?: string; format?: string; content: string; summary?: string }) => Promise<void>;
  onUploadFile: (filename: string, encoding: 'utf8' | 'base64', data: string) => Promise<void>;
  onUploadImageAsset: (
    filename: string,
    base64Data: string
  ) => Promise<{ name: string; mimeType: 'image/png' | 'image/jpeg'; dataUrl: string } | null>;
  onExportDeck: (payload: { title: string; deck: PresentationDeck; saveToWorkspace: boolean }) => Promise<void>;
  onSaveToMemory: (fileId: string, title: string) => void;
  onSaveToKnowledge: (fileId: string, title: string) => Promise<void>;
  onDispatchAgent: (fileId: string, agentId: string, goal: string) => Promise<void>;
  researchList: ResearchProject[];
  labItems: LaboratoryItem[];
  agents: AgentBlueprint[];
}

export const PresentationWorkspace: React.FC<PresentationWorkspaceProps> = ({
  project,
  files,
  activeFile,
  onSelectFile,
  onCreateFile,
  onSaveFile,
  onUploadFile,
  onUploadImageAsset,
  onExportDeck,
  onSaveToMemory,
  onSaveToKnowledge,
  onDispatchAgent,
  researchList,
  labItems,
  agents,
}) => {
  const deckFiles = useMemo(() => files.filter((f) => f.kind === 'presentation'), [files]);
  const [deck, setDeck] = useState<PresentationDeck>(() =>
    activeFile?.kind === 'presentation' ? parseDeckSafe(activeFile.content) : DEFAULT_DECK
  );
  const [selectedSlideIdx, setSelectedSlideIdx] = useState(0);
  const [newDeckName, setNewDeckName] = useState('');
  const [saveExportCopy, setSaveExportCopy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.id || 'agent-task-operator');

  const pptxInputRef = useRef<HTMLInputElement | null>(null);
  const imgInputRef = useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (activeFile && activeFile.kind === 'presentation') {
      setDeck(parseDeckSafe(activeFile.content));
      setSelectedSlideIdx(0);
    }
  }, [activeFile?.id, activeFile?.version]);

  const activeSlide: PresentationSlide = deck.slides[selectedSlideIdx] || deck.slides[0];
  const palette = THEME_STYLES[deck.theme] || THEME_STYLES.genesis_dark;

  const updateSlide = (patch: Partial<PresentationSlide>) => {
    setDeck((prev) => ({
      ...prev,
      slides: prev.slides.map((s, idx) => (idx === selectedSlideIdx ? { ...s, ...patch } : s)),
    }));
  };

  const addSlide = () => {
    const newSlide: PresentationSlide = {
      id: `slide-${Date.now()}`,
      layout: 'title_content',
      title: `Slide ${deck.slides.length + 1}`,
      subtitle: 'Key Points',
      bullets: ['Point 1', 'Point 2'],
    };
    setDeck((prev) => ({ ...prev, slides: [...prev.slides, newSlide] }));
    setSelectedSlideIdx(deck.slides.length);
  };

  const duplicateSlide = () => {
    const clone: PresentationSlide = {
      ...activeSlide,
      id: `slide-${Date.now()}`,
      title: `${activeSlide.title} (Copy)`,
    };
    const nextSlides = [...deck.slides];
    nextSlides.splice(selectedSlideIdx + 1, 0, clone);
    setDeck((prev) => ({ ...prev, slides: nextSlides }));
    setSelectedSlideIdx(selectedSlideIdx + 1);
  };

  const moveSlide = (dir: -1 | 1) => {
    const target = selectedSlideIdx + dir;
    if (target < 0 || target >= deck.slides.length) return;
    const next = [...deck.slides];
    const [item] = next.splice(selectedSlideIdx, 1);
    next.splice(target, 0, item);
    setDeck((prev) => ({ ...prev, slides: next }));
    setSelectedSlideIdx(target);
  };

  const deleteSlide = () => {
    if (deck.slides.length <= 1) return;
    const next = deck.slides.filter((_, idx) => idx !== selectedSlideIdx);
    setDeck((prev) => ({ ...prev, slides: next }));
    setSelectedSlideIdx(Math.max(0, selectedSlideIdx - 1));
  };

  const handleSaveDeck = async () => {
    if (!project) return;
    setSaving(true);
    try {
      const jsonContent = JSON.stringify(deck, null, 2);
      if (activeFile && activeFile.kind === 'presentation') {
        await onSaveFile(activeFile.id, {
          content: jsonContent,
          summary: `Updated ${deck.slides.length} slides (${deck.theme})`,
        });
      } else {
        const slug = (deck.title || 'presentation').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        await onCreateFile({
          filename: `${slug}.pptx.json`,
          kind: 'presentation',
          format: 'pptx',
          content: jsonContent,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDeckFile = async () => {
    const base = (newDeckName.trim() || 'new_presentation').replace(/\.(pptx|json)$/gi, '');
    const starter: PresentationDeck = {
      ...DEFAULT_DECK,
      title: base.replace(/_/g, ' '),
    };
    await onCreateFile({
      filename: `${base}.pptx.json`,
      kind: 'presentation',
      format: 'pptx',
      content: JSON.stringify(starter, null, 2),
    });
    setNewDeckName('');
  };

  const handlePptxImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        void onUploadFile(file.name, 'base64', btoa(binary));
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      if (reader.result instanceof ArrayBuffer) {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const uploaded = await onUploadImageAsset(file.name, btoa(binary));
        if (uploaded) {
          updateSlide({ image: uploaded });
        }
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Top Deck Bar */}
      <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[240px]">
          <Presentation className="w-4 h-4 text-blue-400 shrink-0" />
          <input
            type="text"
            value={deck.title}
            onChange={(e) => setDeck((prev) => ({ ...prev, title: e.target.value }))}
            aria-label="Presentation title"
            className="px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm font-medium text-slate-100 focus:outline-none focus:border-blue-500"
          />
          <select
            value={deck.theme}
            onChange={(e) => setDeck((prev) => ({ ...prev, theme: e.target.value as PresentationThemeId }))}
            aria-label="Presentation theme"
            className="px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
          >
            {Object.entries(THEME_STYLES).map(([id, t]) => (
              <option key={id} value={id}>
                Theme: {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => pptxInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import .pptx</span>
          </button>
          <input
            ref={pptxInputRef}
            type="file"
            accept=".pptx"
            onChange={handlePptxImport}
            className="hidden"
          />
          <button
            type="button"
            onClick={() =>
              void onExportDeck({
                title: deck.title || 'presentation',
                deck,
                saveToWorkspace: saveExportCopy,
              })
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-slate-200 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-blue-400" />
            <span>Export .pptx</span>
          </button>
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={saveExportCopy}
              onChange={(e) => setSaveExportCopy(e.target.checked)}
            />
            <span>Save disk copy</span>
          </label>
          <button
            type="button"
            onClick={() => void handleSaveDeck()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save Deck'}</span>
          </button>
        </div>
      </div>

      {/* Main 3-Column Studio */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Column 1: Deck Files & Slide Rail */}
        <div className="lg:col-span-3 space-y-4">
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-3.5 space-y-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Deck Files ({deckFiles.length})
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={newDeckName}
                onChange={(e) => setNewDeckName(e.target.value)}
                placeholder="new_deck"
                className="flex-1 min-w-0 px-2.5 py-1 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
              />
              <button
                type="button"
                onClick={() => void handleCreateDeckFile()}
                aria-label="Create presentation"
                className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {deckFiles.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onSelectFile(f)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg border font-mono text-[11px] truncate cursor-pointer ${
                    activeFile?.id === f.id
                      ? 'bg-[#161F2D] border-blue-500/50 text-slate-100'
                      : 'bg-[#0A0D12] border-white/[0.06] text-slate-400'
                  }`}
                >
                  {f.filename}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Slides ({deck.slides.length})
              </span>
              <button
                type="button"
                onClick={addSlide}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-[11px] text-white cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Add</span>
              </button>
            </div>

            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {deck.slides.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedSlideIdx(idx)}
                  className={`w-full text-left p-2.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                    idx === selectedSlideIdx
                      ? 'bg-[#161F2D] border-blue-500/50 text-slate-100'
                      : 'bg-[#0A0D12] border-white/[0.06] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold truncate">
                      {idx + 1}. {s.title}
                    </span>
                    <span className="text-[10px] text-slate-500 shrink-0">{s.layout}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-1 pt-2 border-t border-white/[0.06]">
              <button
                type="button"
                onClick={() => moveSlide(-1)}
                disabled={selectedSlideIdx === 0}
                title="Move slide up"
                className="p-1.5 rounded bg-[#0A0D12] border border-white/[0.08] text-slate-400 hover:text-slate-100 disabled:opacity-40 cursor-pointer"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => moveSlide(1)}
                disabled={selectedSlideIdx === deck.slides.length - 1}
                title="Move slide down"
                className="p-1.5 rounded bg-[#0A0D12] border border-white/[0.08] text-slate-400 hover:text-slate-100 disabled:opacity-40 cursor-pointer"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={duplicateSlide}
                title="Duplicate slide"
                className="p-1.5 rounded bg-[#0A0D12] border border-white/[0.08] text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={deleteSlide}
                disabled={deck.slides.length <= 1}
                title="Delete slide"
                className="p-1.5 rounded bg-[#0A0D12] border border-white/[0.08] text-slate-400 hover:text-red-400 disabled:opacity-40 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Column 2: 16:9 Live Slide Preview + Assist */}
        <div className="lg:col-span-5 space-y-4">
          <div
            className="aspect-video w-full rounded-xl overflow-hidden border p-6 flex flex-col justify-between shadow-lg"
            style={{
              backgroundColor: palette.bg,
              borderColor: palette.border,
              color: palette.text,
            }}
          >
            {/* Accent Bar */}
            <div className="space-y-4 flex-1 flex flex-col">
              <div className="h-1 w-full rounded-full" style={{ backgroundColor: palette.accent }} />

              {activeSlide.layout === 'title' || activeSlide.layout === 'section' ? (
                <div
                  className="flex-1 rounded-xl border p-6 flex flex-col justify-center gap-2"
                  style={{ backgroundColor: palette.surface, borderColor: palette.border }}
                >
                  <div className="text-xl font-bold leading-tight" style={{ color: palette.title }}>
                    {activeSlide.title}
                  </div>
                  {activeSlide.subtitle && (
                    <div className="text-sm font-medium" style={{ color: palette.accent }}>
                      {activeSlide.subtitle}
                    </div>
                  )}
                  {activeSlide.bullets.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs list-disc pl-4">
                      {activeSlide.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <>
                  <div>
                    <div className="text-base font-bold leading-snug" style={{ color: palette.title }}>
                      {activeSlide.title}
                    </div>
                    {activeSlide.subtitle && (
                      <div className="text-xs mt-0.5" style={{ color: palette.accent }}>
                        {activeSlide.subtitle}
                      </div>
                    )}
                  </div>

                  {activeSlide.layout === 'two_column' || activeSlide.layout === 'comparison' ? (
                    <div className="grid grid-cols-2 gap-3 flex-1">
                      <div
                        className="rounded-lg border p-3 text-xs space-y-1.5"
                        style={{ backgroundColor: palette.surface, borderColor: palette.border }}
                      >
                        <ul className="list-disc pl-4 space-y-1">
                          {activeSlide.bullets.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                      <div
                        className="rounded-lg border p-3 text-xs space-y-1.5"
                        style={{ backgroundColor: palette.surface, borderColor: palette.border }}
                      >
                        {activeSlide.right_title && (
                          <div className="font-semibold" style={{ color: palette.accent }}>
                            {activeSlide.right_title}
                          </div>
                        )}
                        <ul className="list-disc pl-4 space-y-1">
                          {(activeSlide.right_bullets || []).map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : activeSlide.layout === 'diagram' && activeSlide.diagram?.nodes?.length ? (
                    <div className="flex-1 flex flex-col justify-between gap-3">
                      <div className="flex items-center justify-between gap-2 pt-2">
                        {activeSlide.diagram.nodes.slice(0, 5).map((node, nIdx, arr) => (
                          <React.Fragment key={node.id || nIdx}>
                            <div
                              className="flex-1 rounded-lg border p-2.5 text-center"
                              style={{ backgroundColor: palette.surface, borderColor: palette.accent }}
                            >
                              <div className="text-xs font-semibold" style={{ color: palette.title }}>
                                {node.label}
                              </div>
                              {node.role && (
                                <div className="text-[10px] opacity-75 mt-0.5">{node.role}</div>
                              )}
                            </div>
                            {nIdx < arr.length - 1 && (
                              <span className="text-xs font-bold" style={{ color: palette.accent }}>
                                →
                              </span>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                      {activeSlide.bullets.length > 0 && (
                        <ul className="list-disc pl-4 space-y-1 text-xs">
                          {activeSlide.bullets.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex gap-3 min-h-0">
                      <div
                        className="flex-1 rounded-lg border p-3 text-xs overflow-y-auto"
                        style={{ backgroundColor: palette.surface, borderColor: palette.border }}
                      >
                        <ul className="list-disc pl-4 space-y-1.5">
                          {activeSlide.bullets.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                      {activeSlide.image?.dataUrl && (
                        <div className="w-40 shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black/20 flex items-center justify-center">
                          <img
                            src={activeSlide.image.dataUrl}
                            alt={activeSlide.image.name}
                            className="w-full h-full object-contain"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between text-[10px] opacity-70 pt-2">
              <span>{deck.author}</span>
              <span>
                {deck.title} · Slide {selectedSlideIdx + 1}/{deck.slides.length}
              </span>
            </div>
          </div>

          {activeFile && activeFile.kind === 'presentation' && (
            <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onSaveToMemory(activeFile.id, `Deck: ${deck.title}`)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-emerald-300 cursor-pointer"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                <span>Save Memory</span>
              </button>
              <button
                type="button"
                onClick={() => void onSaveToKnowledge(activeFile.id, deck.title)}
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
                    `Review presentation ${deck.title} and create speaker brief notes.`
                  )
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-indigo-300 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Agent</span>
              </button>
            </div>
          )}

          <CreatorAssistPanel
            workspace="presentations"
            title={deck.title}
            content={deck.slides.map((s) => `# ${s.title}\n${s.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n')}
            researchList={researchList}
            labItems={labItems}
            defaultResearchId={project?.linked_research_id}
            actions={[{ id: 'outline', label: 'Generate Slide Outline Deck' }]}
            onApplyDeck={(generated) => {
              setDeck(generated);
              setSelectedSlideIdx(0);
            }}
          />
        </div>

        {/* Column 3: Slide Properties Editor */}
        <div className="lg:col-span-4 rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
            <LayoutTemplate className="w-4 h-4 text-blue-400" />
            <span>Slide {selectedSlideIdx + 1} Properties</span>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Layout</label>
            <select
              value={activeSlide.layout}
              onChange={(e) => {
                const layout = e.target.value as SlideLayout;
                const patch: Partial<PresentationSlide> = { layout };
                if (layout === 'diagram' && !activeSlide.diagram) {
                  patch.diagram = {
                    kind: 'architecture',
                    nodes: [
                      { id: 'n1', label: 'Input', role: 'Client' },
                      { id: 'n2', label: 'Engine', role: 'Local Core' },
                      { id: 'n3', label: 'Output', role: 'Artifact' },
                    ],
                    edges: [
                      { from: 'n1', to: 'n2' },
                      { from: 'n2', to: 'n3' },
                    ],
                  };
                }
                updateSlide(patch);
              }}
              className="w-full px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
            >
              <option value="title">Title Slide</option>
              <option value="title_content">Title & Content</option>
              <option value="two_column">Two Column</option>
              <option value="comparison">Comparison</option>
              <option value="diagram">Architecture Diagram</option>
              <option value="section">Section Header</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Slide Title</label>
            <input
              type="text"
              value={activeSlide.title}
              onChange={(e) => updateSlide({ title: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Subtitle</label>
            <input
              type="text"
              value={activeSlide.subtitle || ''}
              onChange={(e) => updateSlide({ subtitle: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Bullets (one per line)</label>
            <textarea
              rows={4}
              value={activeSlide.bullets.join('\n')}
              onChange={(e) => updateSlide({ bullets: e.target.value.split('\n').filter(Boolean) })}
              className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 font-mono"
            />
          </div>

          {(activeSlide.layout === 'two_column' || activeSlide.layout === 'comparison') && (
            <>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Right Column Heading</label>
                <input
                  type="text"
                  value={activeSlide.right_title || ''}
                  onChange={(e) => updateSlide({ right_title: e.target.value })}
                  className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Right Column Bullets</label>
                <textarea
                  rows={3}
                  value={(activeSlide.right_bullets || []).join('\n')}
                  onChange={(e) =>
                    updateSlide({ right_bullets: e.target.value.split('\n').filter(Boolean) })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 font-mono"
                />
              </div>
            </>
          )}

          {activeSlide.layout === 'diagram' && (
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Diagram Nodes (Label | Role per line)
              </label>
              <textarea
                rows={4}
                value={(activeSlide.diagram?.nodes || [])
                  .map((n) => `${n.label}${n.role ? ` | ${n.role}` : ''}`)
                  .join('\n')}
                onChange={(e) => {
                  const nodes = e.target.value
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .map((line, i) => {
                      const [label, role] = line.split('|').map((p) => p.trim());
                      return { id: `n${i + 1}`, label: label || `Node ${i + 1}`, role };
                    });
                  const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
                  updateSlide({ diagram: { kind: 'architecture', nodes, edges } });
                }}
                className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 font-mono"
              />
            </div>
          )}

          {activeSlide.layout === 'title_content' && (
            <div className="space-y-2 pt-1 border-t border-white/[0.06]">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-400">Validated PNG/JPEG Image</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => imgInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-[11px] text-slate-200 cursor-pointer"
                  >
                    <ImagePlus className="w-3 h-3" />
                    <span>Upload Image</span>
                  </button>
                  {activeSlide.image && (
                    <button
                      type="button"
                      onClick={() => updateSlide({ image: undefined })}
                      className="text-[11px] text-red-400 hover:underline cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={imgInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </div>
              {activeSlide.image && (
                <div className="text-[11px] text-emerald-300 font-mono truncate">
                  Attached: {activeSlide.image.name}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Speaker Notes</label>
            <textarea
              rows={2}
              value={activeSlide.notes || ''}
              onChange={(e) => updateSlide({ notes: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
