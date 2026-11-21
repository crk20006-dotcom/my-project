import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Database,
  Download,
  FileText,
  RotateCcw,
  Save,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type {
  DatabaseIntegrityReport,
  HealthResponse,
  ModelEntry,
  SystemLogsResponse,
  SystemSettings,
} from '../../types/genesis';

interface GenesisSystemSettingsModuleProps {
  settings: SystemSettings | null;
  onSettingsUpdated: (next: SystemSettings) => void;
}

export const GenesisSystemSettingsModule: React.FC<GenesisSystemSettingsModuleProps> = ({
  settings,
  onSettingsUpdated,
}) => {
  const [operatorName, setOperatorName] = useState(settings?.operator_name ?? 'Local Operator');
  const [localAuthEnabled, setLocalAuthEnabled] = useState(settings?.local_auth_enabled ?? false);
  const [currentPasscode, setCurrentPasscode] = useState('');
  const [newPasscode, setNewPasscode] = useState('');
  const [inferenceUrl, setInferenceUrl] = useState(
    settings?.inference_endpoint_url ?? 'http://127.0.0.1:8080'
  );
  const [preferLocal, setPreferLocal] = useState(settings?.prefer_local_inference ?? false);
  const [activeModelId, setActiveModelId] = useState(
    settings?.active_model_id ?? 'genesis-core-placeholder'
  );
  const [chatUseMemory, setChatUseMemory] = useState(settings?.chat_use_memory ?? true);
  const [chatUseKnowledge, setChatUseKnowledge] = useState(settings?.chat_use_knowledge ?? true);
  const [inferenceTemperature, setInferenceTemperature] = useState(
    settings?.inference_temperature ?? 0.2
  );
  const [inferenceMaxTokens, setInferenceMaxTokens] = useState(
    settings?.inference_max_tokens ?? 512
  );
  const [inferenceTimeoutSec, setInferenceTimeoutSec] = useState(
    Math.round((settings?.inference_timeout_ms ?? 30000) / 1000)
  );
  const [maxUploadMb, setMaxUploadMb] = useState(settings?.max_upload_mb ?? 5);
  const [allowedExtText, setAllowedExtText] = useState(
    (settings?.allowed_extensions ?? []).join(', ')
  );
  const [sandboxStrict, setSandboxStrict] = useState(settings?.sandbox_strict_mode ?? true);
  const [voiceSttLanguage, setVoiceSttLanguage] = useState(settings?.voice_stt_language ?? 'en-US');
  const [voiceTtsVoice, setVoiceTtsVoice] = useState(settings?.voice_tts_voice ?? '');
  const [voiceTtsRate, setVoiceTtsRate] = useState(settings?.voice_tts_rate ?? 1.0);
  const [voiceAutoSpeak, setVoiceAutoSpeak] = useState(settings?.voice_auto_speak ?? false);
  const [ocrEnabled, setOcrEnabled] = useState(settings?.ocr_enabled ?? true);
  const [voiceSttUrl, setVoiceSttUrl] = useState(settings?.voice_stt_endpoint_url ?? '');
  const [voiceTtsUrl, setVoiceTtsUrl] = useState(settings?.voice_tts_endpoint_url ?? '');
  const [visionUrl, setVisionUrl] = useState(settings?.vision_endpoint_url ?? '');
  const [browserVoices, setBrowserVoices] = useState<Array<{ name: string; lang: string }>>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    const loadVoices = () => {
      setBrowserVoices(synth.getVoices().map((v) => ({ name: v.name, lang: v.lang })));
    };
    loadVoices();
    synth.addEventListener?.('voiceschanged', loadVoices);
    return () => synth.removeEventListener?.('voiceschanged', loadVoices);
  }, []);

  useEffect(() => {
    if (!settings) return;
    setOperatorName(settings.operator_name);
    setLocalAuthEnabled(settings.local_auth_enabled);
    setInferenceUrl(settings.inference_endpoint_url);
    setPreferLocal(settings.prefer_local_inference);
    setActiveModelId(settings.active_model_id ?? 'genesis-core-placeholder');
    setChatUseMemory(settings.chat_use_memory ?? true);
    setChatUseKnowledge(settings.chat_use_knowledge ?? true);
    setInferenceTemperature(settings.inference_temperature ?? 0.2);
    setInferenceMaxTokens(settings.inference_max_tokens ?? 512);
    setInferenceTimeoutSec(Math.round((settings.inference_timeout_ms ?? 30000) / 1000));
    setMaxUploadMb(settings.max_upload_mb);
    setAllowedExtText((settings.allowed_extensions ?? []).join(', '));
    setSandboxStrict(settings.sandbox_strict_mode);
    setVoiceSttLanguage(settings.voice_stt_language ?? 'en-US');
    setVoiceTtsVoice(settings.voice_tts_voice ?? '');
    setVoiceTtsRate(settings.voice_tts_rate ?? 1.0);
    setVoiceAutoSpeak(settings.voice_auto_speak ?? false);
    setOcrEnabled(settings.ocr_enabled ?? true);
    setVoiceSttUrl(settings.voice_stt_endpoint_url ?? '');
    setVoiceTtsUrl(settings.voice_tts_endpoint_url ?? '');
    setVisionUrl(settings.vision_endpoint_url ?? '');
  }, [settings]);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [integrityReport, setIntegrityReport] = useState<DatabaseIntegrityReport | null>(null);
  const [systemLogs, setSystemLogs] = useState<SystemLogsResponse | null>(null);
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [pendingRestoreSnapshot, setPendingRestoreSnapshot] = useState<{
    filename: string;
    snapshot: Record<string, unknown>;
  } | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = async () => {
    try {
      const res = await apiClient.getHealth();
      setHealth(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Health check failed.');
    }
  };

  const loadSystemLogs = async (level: 'all' | 'info' | 'warn' | 'error' = logLevelFilter) => {
    try {
      const res = await apiClient.getSystemLogs({ limit: 50, level });
      setSystemLogs(res);
    } catch {
      // Ignore transient log read errors
    }
  };

  useEffect(() => {
    void checkHealth();
    void loadSystemLogs('all');
    apiClient
      .listModels()
      .then(setModels)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const exts = allowedExtText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await apiClient.updateSettings({
        operator_name: operatorName,
        local_auth_enabled: localAuthEnabled,
        current_passcode: currentPasscode || undefined,
        new_passcode: newPasscode.trim() || undefined,
        inference_endpoint_url: inferenceUrl,
        prefer_local_inference: preferLocal,
        active_model_id: activeModelId,
        chat_use_memory: chatUseMemory,
        chat_use_knowledge: chatUseKnowledge,
        inference_temperature: inferenceTemperature,
        inference_max_tokens: inferenceMaxTokens,
        inference_timeout_ms: Math.max(1000, inferenceTimeoutSec * 1000),
        max_upload_mb: maxUploadMb,
        allowed_extensions: exts,
        sandbox_strict_mode: sandboxStrict,
        voice_stt_language: voiceSttLanguage,
        voice_tts_voice: voiceTtsVoice,
        voice_tts_rate: voiceTtsRate,
        voice_auto_speak: voiceAutoSpeak,
        ocr_enabled: ocrEnabled,
        voice_stt_endpoint_url: voiceSttUrl.trim(),
        voice_tts_endpoint_url: voiceTtsUrl.trim(),
        vision_endpoint_url: visionUrl.trim(),
      });
      onSettingsUpdated(updated);
      setCurrentPasscode('');
      setNewPasscode('');
      setStatusMessage('System security and runtime configuration saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleExportDb = async () => {
    setError(null);
    try {
      const snapshot = await apiClient.exportDatabaseSnapshot();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `genesis_db_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMessage('Full SQLite JSON backup exported.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export database.');
    }
  };

  const handleExportSqliteBinary = async () => {
    setError(null);
    try {
      const { blob, filename } = await apiClient.exportSqliteBinaryBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMessage(`Binary SQLite database snapshot (${filename}) downloaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download binary SQLite backup.');
    }
  };

  const handleSelectRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Selected file is not a valid Project Genesis JSON backup.');
      }
      setPendingRestoreSnapshot({ filename: file.name, snapshot: parsed });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read JSON backup file.');
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRestoreSnapshot) return;
    setError(null);
    try {
      const res = await apiClient.restoreDatabaseSnapshot(pendingRestoreSnapshot.snapshot);
      const totalRows = Object.values(res.restored_tables).reduce((acc, n) => acc + n, 0);
      setPendingRestoreSnapshot(null);
      setStatusMessage(`Restored ${totalRows} database record(s) atomically at ${new Date(res.restored_at).toLocaleTimeString()}.`);
      const refreshed = await apiClient.getSettings();
      onSettingsUpdated(refreshed);
      await checkHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore JSON backup.');
    }
  };

  const handleRunIntegrityCheck = async () => {
    setError(null);
    try {
      const report = await apiClient.runIntegrityCheck();
      setIntegrityReport(report);
      setStatusMessage(
        report.ok
          ? 'Database integrity verification passed (PRAGMA integrity_check = ok, 0 FK violations).'
          : 'Database integrity check reported warnings or violations.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Integrity check failed.');
    }
  };

  const handleResetWorkspace = async () => {
    try {
      await apiClient.resetWorkspace();
      setConfirmReset(false);
      setStatusMessage('Workspace records reset to starter defaults.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset workspace.');
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 lg:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="pb-5 border-b border-white/[0.08]">
          <h2 className="font-display text-xl font-semibold text-slate-100">
            Genesis System Settings & Security
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Configure local operator authentication, file upload validation policies, inference endpoint security, and database backups.
          </p>
        </div>

        {error && (
          <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error}
          </div>
        )}
        {statusMessage && (
          <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
            {statusMessage}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-6">
          {/* Security & Local Authentication */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
            <div className="flex items-center gap-2 font-display text-base font-semibold text-slate-100">
              <ShieldCheck className="w-4 h-4 text-blue-400" />
              <span>Local Authentication & Operator Identity</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Operator Display Name</label>
                <input
                  type="text"
                  value={operatorName}
                  onChange={(e) => setOperatorName(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  {settings?.has_passcode ? 'Update Local Passcode (optional, min 6 chars)' : 'Set Local Passcode (min 6 chars)'}
                </label>
                <input
                  type="password"
                  value={newPasscode}
                  onChange={(e) => setNewPasscode(e.target.value)}
                  placeholder={settings?.has_passcode ? 'Leave blank to keep existing' : 'Enter passcode'}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {settings?.has_passcode &&
              (Boolean(newPasscode.trim()) ||
                (Boolean(settings.local_auth_enabled) && !localAuthEnabled)) && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">
                    Current Local Passcode (required to change passcode or disable lock)
                  </label>
                  <input
                    type="password"
                    value={currentPasscode}
                    onChange={(e) => setCurrentPasscode(e.target.value)}
                    placeholder="Enter current passcode to authorize security change"
                    className="w-full sm:w-1/2 px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}

            <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={localAuthEnabled}
                onChange={(e) => setLocalAuthEnabled(e.target.checked)}
                className="accent-blue-500"
              />
              <span>Require local operator passcode lock (PBKDF2-HMAC-SHA256 verified)</span>
            </label>
          </div>

          {/* Local Inference & Upload Policy */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-slate-100">
              Local Inference & Upload Validation Policy
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Active Chat Model Adapter
                </label>
                <select
                  value={activeModelId}
                  onChange={(e) => setActiveModelId(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  {models.length === 0 ? (
                    <option value="genesis-core-placeholder">GENESIS CORE (Placeholder Adapter)</option>
                  ) : (
                    models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.status})
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Local Inference Server URL (Loopback Only)
                </label>
                <input
                  type="text"
                  value={inferenceUrl}
                  onChange={(e) => setInferenceUrl(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Temperature (0 - 2)</label>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={inferenceTemperature}
                  onChange={(e) => setInferenceTemperature(Number(e.target.value))}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 tabular-nums focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Max Output Tokens</label>
                <input
                  type="number"
                  min={32}
                  max={8192}
                  step={32}
                  value={inferenceMaxTokens}
                  onChange={(e) => setInferenceMaxTokens(Number(e.target.value))}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 tabular-nums focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Timeout (seconds)</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={inferenceTimeoutSec}
                  onChange={(e) => setInferenceTimeoutSec(Number(e.target.value))}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 tabular-nums focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Max Attachment (MB)</label>
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={maxUploadMb}
                  onChange={(e) => setMaxUploadMb(Number(e.target.value))}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 tabular-nums focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Allowed Attachment Extensions</label>
              <input
                type="text"
                value={allowedExtText}
                onChange={(e) => setAllowedExtText(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferLocal}
                  onChange={(e) => setPreferLocal(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Dispatch Genesis Chat prompts to configured local inference endpoint</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={chatUseMemory}
                  onChange={(e) => setChatUseMemory(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Attach relevant approved User Memory excerpts to Genesis Chat prompts</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={chatUseKnowledge}
                  onChange={(e) => setChatUseKnowledge(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Attach matching Knowledge Base chunks to Genesis Chat prompts</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sandboxStrict}
                  onChange={(e) => setSandboxStrict(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Enforce strict read-only sandbox for autonomous agent tools</span>
              </label>
            </div>
          </div>

          {/* Voice, Speech & Vision Multimodal Settings */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-slate-100">
              Voice, Speech & Vision Preferences (Local Multimodal)
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Speech Recognition Language</label>
                <select
                  value={voiceSttLanguage}
                  onChange={(e) => setVoiceSttLanguage(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (UK)</option>
                  <option value="es-ES">Spanish</option>
                  <option value="fr-FR">French</option>
                  <option value="de-DE">German</option>
                  <option value="hi-IN">Hindi</option>
                  <option value="ja-JP">Japanese</option>
                  <option value="zh-CN">Chinese (Simplified)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Speech Output Voice</label>
                <select
                  value={voiceTtsVoice}
                  onChange={(e) => setVoiceTtsVoice(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="">System Default Voice</option>
                  {browserVoices.map((v) => (
                    <option key={`${v.name}-${v.lang}`} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5 tabular-nums">
                  Speech Speed ({voiceTtsRate.toFixed(1)}x)
                </label>
                <input
                  type="range"
                  min={0.6}
                  max={1.8}
                  step={0.1}
                  value={voiceTtsRate}
                  onChange={(e) => setVoiceTtsRate(Number(e.target.value))}
                  className="w-full accent-blue-500 mt-2"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Local Whisper STT URL (Loopback Optional)
                </label>
                <input
                  type="text"
                  value={voiceSttUrl}
                  onChange={(e) => setVoiceSttUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8081"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Local Piper TTS URL (Loopback Optional)
                </label>
                <input
                  type="text"
                  value={voiceTtsUrl}
                  onChange={(e) => setVoiceTtsUrl(e.target.value)}
                  placeholder="http://127.0.0.1:5000"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Local Vision Model URL (Loopback Optional)
                </label>
                <input
                  type="text"
                  value={visionUrl}
                  onChange={(e) => setVisionUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8082"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] font-mono text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={voiceAutoSpeak}
                  onChange={(e) => setVoiceAutoSpeak(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Automatically read new Genesis Chat responses aloud</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ocrEnabled}
                  onChange={(e) => setOcrEnabled(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Run local Tesseract OCR text extraction automatically on uploaded images</span>
              </label>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Saving...' : 'Save System Configuration'}</span>
              </button>
            </div>
          </div>
        </form>

        {/* Backend Health, Integrity, Backups & Recovery */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-display text-base font-semibold text-slate-100">
              <Activity className="w-4 h-4 text-blue-400" />
              <span>Service Health, Reliability & Database Recovery</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRunIntegrityCheck()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-xs font-medium text-blue-300 cursor-pointer"
              >
                <Database className="w-3.5 h-3.5" />
                <span>Run SQLite Integrity Check</span>
              </button>
              <button
                type="button"
                onClick={() => void checkHealth()}
                className="px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer"
              >
                Refresh Health
              </button>
            </div>
          </div>

          {health && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                <div className="text-slate-500">API Status & Memory</div>
                <div className="font-semibold text-emerald-400 mt-1 uppercase">{health.status}</div>
                <div className="text-slate-400 mt-0.5 tabular-nums">
                  RSS: {health.hardware.process_rss_mb ?? '-'} MB · Host {health.hardware.free_memory_gb} / {health.hardware.total_memory_gb} GB
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                <div className="text-slate-500">Persistent Database</div>
                <div className="font-semibold text-slate-200 mt-1">{health.database.engine}</div>
                <div className="font-mono text-[11px] text-slate-500 mt-0.5 truncate">{health.database.path}</div>
              </div>
              <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                <div className="text-slate-500">Network Binding & Runtime</div>
                <div className="font-semibold text-slate-200 mt-1 font-mono">
                  {health.deployment?.host_binding || '127.0.0.1'}
                </div>
                <div className="text-slate-400 mt-0.5">
                  {health.deployment?.lan_exposed
                    ? 'Container / Explicit LAN bind (enable passcode lock)'
                    : 'Localhost-only bind · 16 GB RAM CPU compatible'}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-[#0A0D12] border border-white/[0.07]">
                <div className="text-slate-500">Independent Operation</div>
                <div className="font-semibold text-slate-200 mt-1">
                  {health.model_inference.external_ai_apis_disabled ? 'Zero External AI APIs' : 'Enabled'}
                </div>
                <div className="text-slate-400 mt-0.5">
                  Buffered Errors: {health.reliability?.error_count ?? 0} · Warns: {health.reliability?.warn_count ?? 0}
                </div>
              </div>
            </div>
          )}

          {integrityReport && (
            <div className="p-4 rounded-lg bg-[#0A0D12] border border-white/[0.08] space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                  <CheckCircle2 className={`w-4 h-4 ${integrityReport.ok ? 'text-emerald-400' : 'text-red-400'}`} />
                  <span>
                    SQLite Integrity: {integrityReport.integrity_check.join(', ')} · FK Violations: {integrityReport.foreign_key_violations}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-slate-400">
                  WAL: {integrityReport.journal_mode} · FTS5: {integrityReport.fts5_enabled ? 'enabled' : 'off'} · {(integrityReport.db_size_bytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                Migrations Applied:{' '}
                {integrityReport.migrations_applied.map((m) => m.version).join(', ')}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/[0.08]">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleExportDb()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export JSON Backup</span>
              </button>

              <button
                type="button"
                onClick={() => void handleExportSqliteBinary()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs font-medium text-slate-200 cursor-pointer"
              >
                <Database className="w-3.5 h-3.5" />
                <span>Download Binary .db</span>
              </button>

              <input
                ref={restoreFileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => void handleSelectRestoreFile(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => restoreFileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-medium text-amber-200 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Restore JSON Backup</span>
              </button>
            </div>

            {confirmReset ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-300">Confirm reset of workspace records?</span>
                <button
                  type="button"
                  onClick={() => void handleResetWorkspace()}
                  className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-medium text-white cursor-pointer"
                >
                  Confirm Reset
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="px-3 py-1.5 rounded-lg border border-white/[0.1] text-xs text-slate-300 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-xs font-medium text-red-300 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Demo Workspace</span>
              </button>
            )}
          </div>

          {pendingRestoreSnapshot && (
            <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-amber-200">
                Confirm atomic restore from <strong>{pendingRestoreSnapshot.filename}</strong>? Existing records will be replaced cleanly inside a transaction.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleConfirmRestore()}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium cursor-pointer"
                >
                  Confirm Restore
                </button>
                <button
                  type="button"
                  onClick={() => setPendingRestoreSnapshot(null)}
                  className="px-3 py-1.5 rounded-lg border border-white/[0.1] text-slate-300 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Structured Server Error & Event Logs */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11161F] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-display text-base font-semibold text-slate-100">
              <FileText className="w-4 h-4 text-blue-400" />
              <span>Application Error & Security Logs</span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={logLevelFilter}
                onChange={(e) => {
                  const next = e.target.value as 'all' | 'info' | 'warn' | 'error';
                  setLogLevelFilter(next);
                  void loadSystemLogs(next);
                }}
                className="px-2.5 py-1.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-xs text-slate-200"
              >
                <option value="all">All Levels</option>
                <option value="error">Errors</option>
                <option value="warn">Warnings</option>
                <option value="info">Info</option>
              </select>
              <button
                type="button"
                onClick={() => void loadSystemLogs(logLevelFilter)}
                className="px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#161C26] hover:bg-[#1E2634] text-xs text-slate-200 cursor-pointer"
              >
                Refresh Logs
              </button>
            </div>
          </div>

          <div className="rounded-lg bg-[#0A0D12] border border-white/[0.07] max-h-56 overflow-y-auto divide-y divide-white/[0.06] text-xs">
            {!systemLogs || systemLogs.logs.length === 0 ? (
              <div className="p-4 text-slate-500">No buffered events recorded in this session yet.</div>
            ) : (
              systemLogs.logs.map((entry) => (
                <div key={entry.id} className="px-3.5 py-2 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`font-mono text-[11px] font-semibold uppercase ${
                        entry.level === 'error'
                          ? 'text-red-400'
                          : entry.level === 'warn'
                            ? 'text-amber-400'
                            : 'text-blue-400'
                      }`}
                    >
                      [{entry.level}] {entry.category}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-slate-200">{entry.message}</div>
                  {entry.detail && (
                    <div className="font-mono text-[11px] text-slate-500 truncate">{entry.detail}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
