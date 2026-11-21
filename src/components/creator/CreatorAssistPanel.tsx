import React, { useState } from 'react';
import { Sparkles, Loader2, ArrowDownToLine, Cpu, Database, FlaskConical, BookOpen } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  CreatorAssistResponse,
  LaboratoryItem,
  PresentationDeck,
  ResearchProject,
} from '../../types/genesis';

interface CreatorAssistPanelProps {
  workspace: 'coding' | 'documents' | 'presentations';
  language?: string;
  title: string;
  content: string;
  researchList: ResearchProject[];
  labItems: LaboratoryItem[];
  defaultResearchId?: string | null;
  actions: Array<{ id: string; label: string }>;
  onApplyDraft?: (draft: string) => void;
  onApplyDeck?: (deck: PresentationDeck) => void;
}

export const CreatorAssistPanel: React.FC<CreatorAssistPanelProps> = ({
  workspace,
  language,
  title,
  content,
  researchList,
  labItems,
  defaultResearchId,
  actions,
  onApplyDraft,
  onApplyDeck,
}) => {
  const [action, setAction] = useState(actions[0]?.id || 'assist');
  const [goal, setGoal] = useState('');
  const [useMemory, setUseMemory] = useState(true);
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [researchId, setResearchId] = useState<string>(defaultResearchId || '');
  const [labId, setLabId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatorAssistResponse | null>(null);

  const handleRunAssist = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.creatorAssist({
        workspace,
        action,
        language,
        title,
        content,
        goal: goal.trim() || undefined,
        use_memory: useMemory,
        use_knowledge: useKnowledge,
        research_id: researchId || null,
        laboratory_item_id: labId || null,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Genesis Assist request failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-blue-400" />
          <h4 className="font-display text-xs font-semibold uppercase tracking-wider text-slate-200">
            Genesis Intelligence Assist
          </h4>
        </div>
        {result && (
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              result.mode === 'local_inference'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
            }`}
          >
            {result.mode === 'local_inference' ? 'Local Model' : 'Demo Mode + Deterministic'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Action</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200 focus:outline-none"
          >
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Linked Research Study</label>
          <select
            value={researchId}
            onChange={(e) => setResearchId(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200 focus:outline-none"
          >
            <option value="">None</option>
            {researchList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Laboratory Template</label>
          <select
            value={labId}
            onChange={(e) => setLabId(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200 focus:outline-none"
          >
            <option value="">None</option>
            {labItems.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.kind})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end gap-4 pb-1">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={useMemory}
              onChange={(e) => setUseMemory(e.target.checked)}
              className="rounded border-white/20 bg-[#0A0D12]"
            />
            <span>Memory</span>
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={useKnowledge}
              onChange={(e) => setUseKnowledge(e.target.checked)}
              className="rounded border-white/20 bg-[#0A0D12]"
            />
            <span>Knowledge Base</span>
          </label>
        </div>
      </div>

      <div>
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Optional goal or topic (e.g., Implement ring buffer or Summarize architecture)..."
          className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
        />
      </div>

      <button
        type="button"
        onClick={() => void handleRunAssist()}
        disabled={loading}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white cursor-pointer"
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
        <span>{loading ? 'Querying Local Context...' : 'Run Genesis Assist'}</span>
      </button>

      {error && (
        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Cpu className="w-3 h-3 text-blue-400" />
              {result.model_name}
            </span>
            <span className="inline-flex items-center gap-1">
              <Database className="w-3 h-3 text-emerald-400" />
              {result.context_used.memories.length} mem / {result.context_used.knowledge.length} KB
            </span>
            {result.context_used.research_title && (
              <span className="inline-flex items-center gap-1 text-indigo-300">
                <BookOpen className="w-3 h-3" />
                {result.context_used.research_title}
              </span>
            )}
            {result.context_used.laboratory_template && (
              <span className="inline-flex items-center gap-1 text-cyan-300">
                <FlaskConical className="w-3 h-3" />
                {result.context_used.laboratory_template}
              </span>
            )}
          </div>

          {result.inference_error && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-300">
              Local model note: {result.inference_error}
            </div>
          )}

          {result.inference_output && (
            <div className="p-2.5 rounded-lg bg-[#0A0D12] border border-emerald-500/20 text-xs text-slate-200 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {result.inference_output}
            </div>
          )}

          <div className="p-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.08] text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">
            {result.deterministic_summary}
          </div>

          <div className="flex flex-wrap gap-2">
            {result.suggested_draft && onApplyDraft && (
              <button
                type="button"
                onClick={() => onApplyDraft(result.suggested_draft!)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-blue-300 cursor-pointer"
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                <span>Apply Deterministic Draft</span>
              </button>
            )}
            {result.inference_output && onApplyDraft && (
              <button
                type="button"
                onClick={() => onApplyDraft(result.inference_output!)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-xs text-emerald-300 cursor-pointer"
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                <span>Apply Model Output</span>
              </button>
            )}
            {result.suggested_deck && onApplyDeck && (
              <button
                type="button"
                onClick={() => onApplyDeck(result.suggested_deck!)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#161C26] hover:bg-[#1E2634] border border-white/[0.1] text-xs text-blue-300 cursor-pointer"
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                <span>Apply Generated Deck ({result.suggested_deck.slides.length} slides)</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
