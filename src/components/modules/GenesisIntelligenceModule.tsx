import React, { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Cpu, RefreshCw, ShieldAlert } from 'lucide-react';
import { AI_ARCHITECTURE_SPECS } from '../../ai/contracts';
import { apiClient } from '../../services/apiClient';
import type { GenesisCoreStatusResponse, ModelEntry } from '../../types/genesis';

export const GenesisIntelligenceModule: React.FC = () => {
  const [layerFilter, setLayerFilter] = useState<string>('All');
  const [selectedSpecId, setSelectedSpecId] = useState<string>(AI_ARCHITECTURE_SPECS[0].id);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [coreStatus, setCoreStatus] = useState<GenesisCoreStatusResponse | null>(null);
  const [probeResult, setProbeResult] = useState<{ id: string; reachable: boolean; message: string } | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);

  useEffect(() => {
    apiClient.listModels().then(setModels).catch(() => {});
    apiClient.getGenesisCoreStatus().then(setCoreStatus).catch(() => {});
  }, []);

  const layers = ['All', 'Core Model', 'Runtime', 'Memory', 'Orchestration', 'Configuration'];
  const filteredSpecs =
    layerFilter === 'All'
      ? AI_ARCHITECTURE_SPECS
      : AI_ARCHITECTURE_SPECS.filter((s) => s.layer === layerFilter);

  const activeSpec =
    filteredSpecs.find((s) => s.id === selectedSpecId) || filteredSpecs[0] || AI_ARCHITECTURE_SPECS[0];

  const handleProbe = async (id: string) => {
    setProbingId(id);
    try {
      const res = await apiClient.probeModel(id);
      setProbeResult({ id, reachable: res.reachable, message: res.message });
    } catch (err) {
      setProbeResult({
        id,
        reachable: false,
        message: err instanceof Error ? err.message : 'Probe failed.',
      });
    } finally {
      setProbingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header & Filter Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Provider-Independent AI Architecture
            </h2>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Abstract engine contracts decoupling application logic from neural runtimes so GENESIS CORE weights or local inference servers attach cleanly without vendor lock-in.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#11161F] border border-white/[0.08]">
            {layers.map((layer) => (
              <button
                key={layer}
                type="button"
                onClick={() => setLayerFilter(layer)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  layerFilter === layer
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {layer}
              </button>
            ))}
          </div>
        </div>

        {coreStatus && (
          <div className="rounded-xl border border-amber-500/25 bg-[#11161F] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-amber-300">
                {coreStatus.trained
                  ? `Genesis Core Experimental Checkpoint (${coreStatus.trained_steps} steps)`
                  : 'Genesis Core Status: Untrained / Experimental Prototype'}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                PyTorch decoder architecture (`{coreStatus.architecture.class_name}`) and trainable Byte-BPE tokenizer (`{coreStatus.architecture.tokenizer_class}`). Checkpoint slot: <span className="font-mono text-slate-300">{coreStatus.checkpoint_path}</span>
              </div>
            </div>
            <div className="text-xs font-mono text-slate-400 whitespace-nowrap">
              {coreStatus.checkpoint_exists ? 'Checkpoint On Disk' : 'No Checkpoint Trained'}
            </div>
          </div>
        )}

        {/* Two-Column Interface Explorer */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Interface Contracts List */}
          <div className="lg:col-span-5 space-y-2">
            {filteredSpecs.map((spec) => {
              const selected = spec.id === activeSpec.id;
              return (
                <button
                  key={spec.id}
                  type="button"
                  onClick={() => setSelectedSpecId(spec.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                    selected
                      ? 'bg-[#141B26] border-blue-500/50'
                      : 'bg-[#11161F] border-white/[0.08] hover:border-white/[0.16]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-semibold text-slate-100">
                      {spec.name}
                    </span>
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">
                      {spec.layer}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1.5 line-clamp-2">
                    {spec.description}
                  </div>
                  <div className="text-[11px] font-medium mt-2.5 text-blue-300">
                    {spec.implementationStatus}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: Contract Specification Detail */}
          <div className="lg:col-span-7 rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-white/[0.08]">
              <div>
                <div className="text-xs text-slate-400">
                  {activeSpec.layer} · {activeSpec.implementationStatus}
                </div>
                <h3 className="font-display text-lg font-semibold text-slate-100 mt-1">
                  {activeSpec.name}
                </h3>
              </div>
              <Cpu className="w-5 h-5 text-blue-400 shrink-0" />
            </div>

            <p className="text-sm text-slate-300 leading-relaxed">{activeSpec.description}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                <div className="text-slate-500 mb-1">Python FastAPI Contract</div>
                <div className="font-mono text-slate-200 break-all">{activeSpec.pythonClass}</div>
              </div>
              <div className="p-3 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                <div className="text-slate-500 mb-1">TypeScript Interface</div>
                <div className="font-mono text-slate-200 break-all">{activeSpec.typescriptInterface}</div>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-slate-300 mb-2.5">
                Contract Methods
              </h4>
              <div className="divide-y divide-white/[0.06] border border-white/[0.07] rounded-lg bg-[#0A0D12]">
                {activeSpec.methods.map((m) => (
                  <div key={m.name} className="p-3.5">
                    <div className="font-mono text-xs text-blue-300">
                      {m.name}{m.signature}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">{m.purpose}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Adapter Connectivity Diagnostics */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-100">
                Adapter Readiness & Endpoint Probe
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Verify placeholder GENESIS CORE adapter state or probe a running local HTTP inference server.
              </p>
            </div>
          </div>

          <div className="divide-y divide-white/[0.06] border border-white/[0.07] rounded-lg bg-[#0A0D12]">
            {models.map((m) => (
              <div key={m.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-100">{m.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5 font-mono truncate">
                    {m.provider} · {m.endpoint_url || m.local_path || 'No endpoint set'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleProbe(m.id)}
                  disabled={probingId === m.id}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${probingId === m.id ? 'animate-spin' : ''}`} />
                  <span>{probingId === m.id ? 'Probing...' : 'Verify Adapter'}</span>
                </button>
              </div>
            ))}
          </div>

          {probeResult && (
            <div
              className={`mt-4 p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
                probeResult.reachable
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                  : 'bg-amber-500/10 border-amber-500/25 text-amber-200'
              }`}
            >
              {probeResult.reachable ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              )}
              <div>
                <div className="font-medium flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5" />
                  <span>{probeResult.reachable ? 'Connected' : 'Placeholder / Unconnected'}</span>
                </div>
                <p className="mt-1 text-slate-300">{probeResult.message}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
