import React, { useEffect, useState } from 'react';
import { Boxes, Check, Cpu, HardDrive, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  GenesisCoreStatusResponse,
  HealthResponse,
  ModelEntry,
  ModelProviderType,
  SystemSettings,
} from '../../types/genesis';

interface GenesisModelManagerModuleProps {
  settings?: SystemSettings | null;
  onSettingsUpdated?: (next: SystemSettings) => void;
}

export const GenesisModelManagerModule: React.FC<GenesisModelManagerModuleProps> = ({
  settings,
  onSettingsUpdated,
}) => {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [genesisCoreStatus, setGenesisCoreStatus] = useState<GenesisCoreStatusResponse | null>(null);
  const [browserGpu, setBrowserGpu] = useState<string>('Checking WebGPU...');
  const [loading, setLoading] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeBanner, setProbeBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editEndpointUrl, setEditEndpointUrl] = useState<string>('');
  const [editContextLength, setEditContextLength] = useState<number>(8192);

  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ModelProviderType>('gguf_local');
  const [modelType, setModelType] = useState('Local GGUF Foundation Weights');
  const [localPath, setLocalPath] = useState('./weights/genesis-local.gguf');
  const [endpointUrl, setEndpointUrl] = useState('http://127.0.0.1:8080');
  const [contextLength, setContextLength] = useState(8192);
  const [quantization, setQuantization] = useState('Q4_K_M');
  const [parameterCount, setParameterCount] = useState('7B Target');

  const refresh = async () => {
    setLoading(true);
    try {
      const [m, h, gc] = await Promise.all([
        apiClient.listModels(),
        apiClient.getHealth(),
        apiClient.getGenesisCoreStatus().catch(() => null),
      ]);
      setModels(m);
      setHealth(h);
      setGenesisCoreStatus(gc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load model registry.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } };
    if (nav.gpu) {
      nav.gpu
        .requestAdapter()
        .then((adapter) => setBrowserGpu(adapter ? 'WebGPU Adapter Available' : 'WebGPU Unavailable'))
        .catch(() => setBrowserGpu('WebGPU Unavailable'));
    } else {
      setBrowserGpu('WebGPU Not Supported in Browser');
    }
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiClient.registerModel({
        name,
        provider,
        model_type: modelType,
        local_path: localPath,
        endpoint_url: endpointUrl,
        context_length: contextLength,
        quantization,
        parameter_count: parameterCount,
      });
      setModels((prev) => [...prev, created]);
      setShowRegister(false);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register model.');
    }
  };

  const handleProbe = async (id: string) => {
    setProbingId(id);
    setProbeBanner(null);
    try {
      const res = await apiClient.probeModel(id);
      setProbeBanner(res.message);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to probe endpoint.');
    } finally {
      setProbingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await apiClient.deleteModel(id);
      setModels((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete model.');
    }
  };

  const handleStartEdit = (m: ModelEntry) => {
    setEditingModelId(m.id);
    setEditEndpointUrl(m.endpoint_url || '');
    setEditContextLength(m.context_length || 8192);
    setError(null);
  };

  const handleSaveEdit = async (id: string) => {
    setError(null);
    try {
      const updated = await apiClient.updateModel(id, {
        endpoint_url: editEndpointUrl,
        context_length: editContextLength,
      });
      setModels((prev) => prev.map((m) => (m.id === id ? updated : m)));
      setEditingModelId(null);
      setProbeBanner(`Updated endpoint configuration for ${updated.name}. Run Probe to verify connection.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update model endpoint.');
    }
  };

  const handleSetActiveForChat = async (m: ModelEntry) => {
    setError(null);
    try {
      const updated = await apiClient.updateSettings({
        active_model_id: m.id,
        prefer_local_inference: m.provider === 'local_http',
      });
      onSettingsUpdated?.(updated);
      setProbeBanner(`Default chat adapter set to ${m.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update active model.');
    }
  };

  const connectedModel = models.find((m) => m.status === 'connected') || null;
  const activeChatModelId = settings?.active_model_id || 'genesis-core-placeholder';

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Genesis Model Manager
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Manage local model weight manifests, GENESIS CORE placeholder adapters, hardware telemetry, and local inference endpoints.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowRegister((v) => !v)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{showRegister ? 'Cancel' : 'Register Local Model'}</span>
          </button>
        </div>

        {/* Real Hardware Telemetry Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Cpu className="w-3.5 h-3.5 text-blue-400" />
              <span>Host Processor</span>
            </div>
            <div className="text-sm font-semibold text-slate-100 mt-1.5 truncate">
              {health?.hardware.cpu_model || 'Detecting...'}
            </div>
            <div className="text-xs text-slate-500 tabular-nums mt-0.5">
              {health?.hardware.cpu_cores ?? '-'} logical cores · {health?.hardware.arch || '-'}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <HardDrive className="w-3.5 h-3.5 text-blue-400" />
              <span>Host Memory</span>
            </div>
            <div className="text-sm font-semibold text-slate-100 tabular-nums mt-1.5">
              {health ? `${health.hardware.free_memory_gb} GB Free / ${health.hardware.total_memory_gb} GB` : 'Detecting...'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {health?.hardware.platform || '-'}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Boxes className="w-3.5 h-3.5 text-blue-400" />
              <span>Client Accelerator</span>
            </div>
            <div className="text-sm font-semibold text-slate-100 mt-1.5">{browserGpu}</div>
            <div className="text-xs text-slate-500 tabular-nums mt-0.5">
              Browser threads: {navigator.hardwareConcurrency || '-'}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-4">
            <div className="text-xs text-slate-400">Active Inference State</div>
            <div
              className={`text-sm font-semibold mt-1.5 truncate ${
                connectedModel ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {connectedModel
                ? connectedModel.metadata?.server_model || connectedModel.name
                : 'No Weights Loaded'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {connectedModel ? `Connected · ${connectedModel.endpoint_url}` : 'External AI APIs disabled'}
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error}
          </div>
        )}

        {genesisCoreStatus && (
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-amber-300">
                  {genesisCoreStatus.trained
                    ? `Experimental Prototype · Trained ${genesisCoreStatus.trained_steps} steps`
                    : 'Experimental Prototype · Untrained (0 Steps)'}
                </div>
                <h3 className="font-display text-base font-semibold text-slate-100 mt-0.5">
                  Genesis Core Foundation ({genesisCoreStatus.architecture.class_name} ·{' '}
                  {genesisCoreStatus.architecture.tokenizer_class})
                </h3>
              </div>
              <div className="text-xs font-mono text-slate-400 text-right">
                <div>
                  Checkpoint: {genesisCoreStatus.checkpoint_path}{' '}
                  {genesisCoreStatus.checkpoint_exists
                    ? `(Present · ${((genesisCoreStatus.checkpoint_size_bytes || 0) / 1024).toFixed(1)} KB)`
                    : '(Not Trained Yet)'}
                </div>
                <div className="text-[11px] text-slate-500">
                  Tokenizer: {genesisCoreStatus.tokenizer_path}{' '}
                  {genesisCoreStatus.tokenizer_exists
                    ? `(Vocab ${genesisCoreStatus.tokenizer_vocab_size ?? 'present'})`
                    : '(Not Generated)'}
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Independent from-scratch decoder-only PyTorch Transformer with CPU-first Windows presets.
              {genesisCoreStatus.ram_budget_note ? ` ${genesisCoreStatus.ram_budget_note}` : ''}
            </p>
            {genesisCoreStatus.capabilities && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-[#0A0D12] border border-emerald-500/20">
                  <div className="font-semibold text-emerald-300 mb-1">Operational Capabilities</div>
                  <ul className="space-y-1 text-slate-400 list-disc pl-4">
                    {genesisCoreStatus.capabilities.operational.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-3 rounded-lg bg-[#0A0D12] border border-amber-500/20">
                  <div className="font-semibold text-amber-300 mb-1">Experimental / Requires Local Training</div>
                  <ul className="space-y-1 text-slate-400 list-disc pl-4">
                    {genesisCoreStatus.capabilities.experimental_untrained.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <div className="p-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.07] font-mono text-[11px] text-blue-300 overflow-x-auto">
              {genesisCoreStatus.training_command}
            </div>
          </div>
        )}

        {probeBanner && (
          <div className="p-3.5 rounded-lg bg-[#11161F] border border-blue-500/30 text-xs text-slate-200">
            {probeBanner}
          </div>
        )}

        {showRegister && (
          <form onSubmit={handleRegister} className="rounded-xl border border-white/[0.1] bg-[#11161F] p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-slate-100">
              Register Local Model Manifest
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Model Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., GENESIS-7B-Q4"
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Provider Adapter</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ModelProviderType)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                >
                  <option value="gguf_local">Local GGUF Weights</option>
                  <option value="safetensors_local">Local Safetensors Checkpoint</option>
                  <option value="local_http">Local HTTP Inference Server</option>
                  <option value="genesis_core">GENESIS CORE Adapter</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Model Type</label>
                <input
                  type="text"
                  value={modelType}
                  onChange={(e) => setModelType(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Local Weights Path</label>
                <input
                  type="text"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Local Inference Endpoint</label>
                <input
                  type="text"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8080"
                  className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Context</label>
                  <input
                    type="number"
                    value={contextLength}
                    onChange={(e) => setContextLength(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 tabular-nums focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Quantization</label>
                  <input
                    type="text"
                    value={quantization}
                    onChange={(e) => setQuantization(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none"
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                Register Manifest
              </button>
            </div>
          </form>
        )}

        {/* Models Data Grid */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08] text-[11px] font-medium text-slate-400 bg-[#0E131B]">
                  <th className="py-3 px-4">Model Name</th>
                  <th className="py-3 px-4">Type & Quantization</th>
                  <th className="py-3 px-4">Location / Endpoint</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Loading</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 px-4 text-center text-slate-500">
                      Loading registered models...
                    </td>
                  </tr>
                ) : (
                  models.map((m) => {
                    const isEditing = editingModelId === m.id;
                    return (
                      <tr key={m.id} className="hover:bg-white/[0.02]">
                        <td className="py-3.5 px-4">
                          <div className="font-medium text-slate-100">{m.name}</div>
                          <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            {m.metadata?.server_model
                              ? `Server Model: ${m.metadata.server_model} · ${m.context_length.toLocaleString()} ctx`
                              : `${m.parameter_count} · ${m.context_length.toLocaleString()} ctx`}
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="text-slate-300">{m.model_type}</div>
                          <div className="text-[11px] font-mono text-slate-500 mt-0.5">{m.quantization}</div>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[11px] text-slate-400 max-w-[280px]">
                          {isEditing ? (
                            <div className="flex flex-col gap-1.5">
                              <input
                                type="text"
                                value={editEndpointUrl}
                                onChange={(e) => setEditEndpointUrl(e.target.value)}
                                placeholder="http://127.0.0.1:8080"
                                className="w-full px-2 py-1 rounded bg-[#0A0D12] border border-blue-500 font-mono text-xs text-slate-100 focus:outline-none"
                              />
                              <input
                                type="number"
                                min={512}
                                max={131072}
                                value={editContextLength}
                                onChange={(e) => setEditContextLength(Number(e.target.value))}
                                className="w-28 px-2 py-1 rounded bg-[#0A0D12] border border-white/[0.12] font-mono text-xs text-slate-100 focus:outline-none"
                              />
                            </div>
                          ) : (
                            <div className="truncate">{m.endpoint_url || m.local_path || 'Not configured'}</div>
                          )}
                        </td>
                        <td className="py-3.5 px-4">
                          <span
                            className={`font-medium capitalize ${
                              m.status === 'connected'
                                ? 'text-emerald-400'
                                : m.status === 'placeholder'
                                  ? 'text-blue-300'
                                  : 'text-amber-400'
                            }`}
                          >
                            {m.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 capitalize text-slate-400">{m.loading_status}</td>
                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void handleSaveEdit(m.id)}
                                  aria-label={`Save ${m.name}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white cursor-pointer"
                                >
                                  <Check className="w-3 h-3" />
                                  <span>Save</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingModelId(null)}
                                  aria-label="Cancel endpoint edit"
                                  className="p-1.5 rounded-lg border border-white/[0.1] text-slate-400 hover:text-white cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void handleSetActiveForChat(m)}
                                  disabled={activeChatModelId === m.id}
                                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer ${
                                    activeChatModelId === m.id
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                      : 'border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-slate-200'
                                  }`}
                                >
                                  {activeChatModelId === m.id && <Check className="w-3 h-3" />}
                                  <span>{activeChatModelId === m.id ? 'Active Chat' : 'Set Active'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleProbe(m.id)}
                                  disabled={probingId === m.id}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
                                >
                                  <RefreshCw className={`w-3 h-3 ${probingId === m.id ? 'animate-spin' : ''}`} />
                                  <span>Probe</span>
                                </button>
                                {m.id !== 'genesis-core-placeholder' && (
                                  <button
                                    type="button"
                                    onClick={() => handleStartEdit(m)}
                                    aria-label={`Edit endpoint for ${m.name}`}
                                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.08] cursor-pointer"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {m.id !== 'genesis-core-placeholder' && (
                                  <button
                                    type="button"
                                    onClick={() => void handleDelete(m.id)}
                                    aria-label={`Delete ${m.name}`}
                                    className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
