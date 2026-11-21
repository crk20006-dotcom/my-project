import React, { useState } from 'react';
import { CheckCircle2, Lock, Server, ShieldCheck, User, X } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type { SystemSettings } from '../../types/genesis';

interface FirstRunWizardProps {
  settings: SystemSettings;
  onCompleted: (next: SystemSettings) => void;
}

export const FirstRunWizard: React.FC<FirstRunWizardProps> = ({ settings, onCompleted }) => {
  const [operatorName, setOperatorName] = useState(settings.operator_name || 'Local Operator');
  const [preferLocal, setPreferLocal] = useState(Boolean(settings.prefer_local_inference));
  const [enableLock, setEnableLock] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFinish = async (skipLockSetup = false) => {
    setError(null);
    if (!skipLockSetup && enableLock && passcode.trim().length < 6) {
      setError('Local operator passcode must be at least 6 characters.');
      return;
    }
    setSaving(true);
    try {
      const updated = await apiClient.completeFirstRunSetup({
        operator_name: operatorName.trim() || 'Local Operator',
        prefer_local_inference: preferLocal,
        enable_local_auth: !skipLockSetup && enableLock,
        new_passcode: !skipLockSetup && enableLock ? passcode.trim() : undefined,
      });
      onCompleted(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete initial setup.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="genesis-first-run-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#11161F] p-6 space-y-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/15 border border-blue-500/25 flex items-center justify-center text-blue-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 id="genesis-first-run-title" className="font-display text-base font-semibold text-slate-100">
                Welcome to Project Genesis
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                First-run local workstation configuration · 100% independent, zero paid AI keys required
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleFinish(true)}
            disabled={saving}
            aria-label="Skip initial setup"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300 mb-1.5">
              <User className="w-3.5 h-3.5 text-blue-400" />
              <span>Operator Display Name</span>
            </label>
            <input
              type="text"
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
              placeholder="Local Operator"
              className="w-full px-3.5 py-2 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#0A0D12] p-3.5 space-y-2">
            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={preferLocal}
                onChange={(e) => setPreferLocal(e.target.checked)}
                className="accent-blue-500 mt-0.5"
              />
              <span>
                <strong className="text-slate-100 flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-blue-400" />
                  Connect to local HTTP inference server ({settings.inference_endpoint_url})
                </strong>
                <span className="block text-slate-400 mt-0.5">
                  Leave unchecked to start in Demo Mode cleanly without requiring external processes.
                </span>
              </span>
            </label>
          </div>

          {!settings.has_passcode && (
            <div className="rounded-xl border border-white/[0.08] bg-[#0A0D12] p-3.5 space-y-2.5">
              <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableLock}
                  onChange={(e) => setEnableLock(e.target.checked)}
                  className="accent-blue-500 mt-0.5"
                />
                <span>
                  <strong className="text-slate-100 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-blue-400" />
                    Enable local operator passcode lock (recommended if shared or LAN-accessible)
                  </strong>
                  <span className="block text-slate-400 mt-0.5">
                    Uses PBKDF2-HMAC-SHA256 hashing with HttpOnly cookie sessions. You can change this anytime in System Settings.
                  </span>
                </span>
              </label>

              {enableLock && (
                <input
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Enter new local passcode (min 6 characters)"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#11161F] border border-white/[0.12] text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                />
              )}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/[0.08]">
          <button
            type="button"
            onClick={() => void handleFinish(true)}
            disabled={saving}
            className="px-3.5 py-2 rounded-lg border border-white/[0.1] text-xs text-slate-300 hover:text-white cursor-pointer"
          >
            Use Defaults
          </button>
          <button
            type="button"
            onClick={() => void handleFinish(false)}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Launch Workspace'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
