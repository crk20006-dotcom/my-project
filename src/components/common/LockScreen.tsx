import React, { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { apiClient } from '../../services/apiClient';

interface LockScreenProps {
  operatorName: string;
  notice?: string | null;
  onUnlock: () => void;
}

export const LockScreen: React.FC<LockScreenProps> = ({ operatorName, notice, onUnlock }) => {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setVerifying(true);
    try {
      const res = await apiClient.verifyPasscode(passcode);
      if (res.unlocked) {
        onUnlock();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0D12] text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-white/[0.08] bg-[#11161F] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-display text-lg font-semibold text-slate-100">
              Project Genesis Locked
            </h1>
            <p className="text-xs text-slate-400">
              Local session lock · Operator: {operatorName}
            </p>
          </div>
        </div>

        {notice && (
          <p className="mb-4 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            {notice}
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="genesis-passcode" className="block text-xs font-medium text-slate-300 mb-1.5">
              Local Operator Passcode
            </label>
            <input
              id="genesis-passcode"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Enter local passcode"
              autoFocus
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#0A0D12] border border-white/[0.1] text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={verifying || !passcode}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium text-white transition-colors cursor-pointer"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{verifying ? 'Verifying...' : 'Unlock Workspace'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
