import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FlaskConical, Plus, Trash2, XCircle } from 'lucide-react';
import { inspectTokensDeterministic } from '../../ai/contracts';
import { apiClient } from '../../services/apiClient';
import type { LaboratoryItem } from '../../types/genesis';

export const GenesisLaboratoryModule: React.FC = () => {
  const [sampleText, setSampleText] = useState(
    'def genesis_forward(tokens: list[int]) -> str:\n    # Step 01 Deterministic Baseline Tokenizer Inspection\n    return f"Encoded {len(tokens)} tokens"'
  );
  const [contextLimit, setContextLimit] = useState(8192);

  const [items, setItems] = useState<LaboratoryItem[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [templateBody, setTemplateBody] = useState('');
  const [schemaText, setSchemaText] = useState(
    '{\n  "type": "object",\n  "required": ["task", "max_tokens"],\n  "properties": {\n    "task": { "type": "string" },\n    "max_tokens": { "type": "number" }\n  }\n}'
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient.listLaboratory().then(setItems).catch(() => {});
  }, []);

  const tokenInspection = useMemo(
    () => inspectTokensDeterministic(sampleText, contextLimit),
    [sampleText, contextLimit]
  );

  const schemaValidation = useMemo(() => {
    try {
      const parsed = JSON.parse(schemaText) as Record<string, unknown>;
      return { valid: true, message: `Valid JSON object (${Object.keys(parsed).length} top-level keys)` };
    } catch (err) {
      return { valid: false, message: err instanceof Error ? err.message : 'Invalid JSON' };
    }
  }, [schemaText]);

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!schemaValidation.valid) {
      setError('Fix JSON schema syntax before saving.');
      return;
    }
    try {
      const created = await apiClient.createLaboratoryItem({
        kind: 'prompt_template',
        name: templateName,
        content: templateBody,
        schema_json: schemaText,
        metrics: { tokens: inspectTokensDeterministic(templateBody).token_count },
      });
      setItems((prev) => [created, ...prev]);
      setTemplateName('');
      setTemplateBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template.');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.deleteLaboratoryItem(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item.');
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="pb-5 border-b border-white/[0.08]">
          <h2 className="font-display text-xl font-semibold text-slate-100">
            Genesis Laboratory — Tokenizer & Schema Workbench
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Deterministic local tokenization, UTF-8 byte accounting, context budget analysis, and structured prompt template validation.
          </p>
        </div>

        {/* Interactive Tokenizer Workbench */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-blue-400" />
              <h3 className="font-display text-base font-semibold text-slate-100">
                Deterministic Baseline Tokenizer Inspector
              </h3>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">Context Window:</span>
              <select
                value={contextLimit}
                onChange={(e) => setContextLimit(Number(e.target.value))}
                className="px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-slate-200 tabular-nums focus:outline-none"
              >
                <option value={4096}>4,096 tokens</option>
                <option value={8192}>8,192 tokens</option>
                <option value={16384}>16,384 tokens</option>
                <option value={32768}>32,768 tokens</option>
              </select>
            </div>
          </div>

          <textarea
            rows={4}
            value={sampleText}
            onChange={(e) => setSampleText(e.target.value)}
            placeholder="Paste code, prose, or prompt instructions to inspect token segmentation..."
            className="w-full px-3.5 py-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs leading-relaxed text-slate-100 focus:outline-none focus:border-blue-500"
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
              <div className="text-xs text-slate-500">Tokens</div>
              <div className="text-lg font-semibold font-mono text-slate-100 tabular-nums mt-0.5">
                {tokenInspection.token_count}
              </div>
            </div>
            <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
              <div className="text-xs text-slate-500">UTF-8 Bytes</div>
              <div className="text-lg font-semibold font-mono text-slate-100 tabular-nums mt-0.5">
                {tokenInspection.byte_count}
              </div>
            </div>
            <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
              <div className="text-xs text-slate-500">Characters</div>
              <div className="text-lg font-semibold font-mono text-slate-100 tabular-nums mt-0.5">
                {tokenInspection.char_count}
              </div>
            </div>
            <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
              <div className="text-xs text-slate-500">Context Usage</div>
              <div className="text-lg font-semibold font-mono text-blue-300 tabular-nums mt-0.5">
                {tokenInspection.estimated_context_pct}%
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
            <div className="text-xs text-slate-400 mb-2">
              Token Segmentation Stream (showing first {tokenInspection.tokens.length} segments)
            </div>
            <div className="flex flex-wrap gap-1.5 font-mono text-xs">
              {tokenInspection.tokens.map((tok) => (
                <span
                  key={tok.index}
                  title={`Token ID: ${tok.id} · ${tok.bytes} byte(s)`}
                  className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-slate-200"
                >
                  {tok.text === '\n' ? '\\n' : tok.text.replace(/ /g, '·')}
                  <span className="text-[10px] text-slate-500 ml-1 tabular-nums">#{tok.id}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Prompt Template & JSON Schema Workbench */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleSaveTemplate}
            className="lg:col-span-7 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4"
          >
            <h3 className="font-display text-base font-semibold text-slate-100">
              Create Prompt Template & Input Schema
            </h3>
            {error && (
              <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                {error}
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Template Name</label>
              <input
                type="text"
                required
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g., Code Review Structured Prompt"
                className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Template Body</label>
              <textarea
                rows={4}
                required
                value={templateBody}
                onChange={(e) => setTemplateBody(e.target.value)}
                placeholder="System: {{role}}&#10;Task: {{task}}"
                className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-slate-400">JSON Schema Contract</label>
                <span
                  className={`inline-flex items-center gap-1 text-[11px] ${
                    schemaValidation.valid ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {schemaValidation.valid ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5" />
                  )}
                  <span>{schemaValidation.message}</span>
                </span>
              </div>
              <textarea
                rows={5}
                value={schemaText}
                onChange={(e) => setSchemaText(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Save to Laboratory</span>
              </button>
            </div>
          </form>

          {/* Saved Templates */}
          <div className="lg:col-span-5 space-y-3">
            <h3 className="font-display text-sm font-semibold text-slate-200">
              Saved Laboratory Specs ({items.length})
            </h3>
            {items.map((item) => (
              <div key={item.id} className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-slate-100">{item.name}</div>
                    <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                      {item.kind} · {new Date(item.updated_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDelete(item.id)}
                    aria-label={`Delete ${item.name}`}
                    className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <pre className="p-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.06] font-mono text-[11px] text-slate-300 overflow-x-auto">
                  {item.content}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
