import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { canPromptInstall, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const [showIosGuide, setShowIosGuide] = useState(false);

  if (isInstalled) return null;
  if (!canPromptInstall && !isIOS) return null;

  const handleClick = async () => {
    if (canPromptInstall) {
      await promptInstall();
    } else if (isIOS) {
      setShowIosGuide(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        title="Install Project Genesis as a standalone desktop or mobile app"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-xs font-medium text-blue-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Install App</span>
      </button>

      {showIosGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Install Project Genesis on iOS"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-sm rounded-xl border border-white/[0.1] bg-[#11161F] p-5 space-y-3 text-slate-200 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold">Install on iPhone / iPad</h3>
              <button
                type="button"
                onClick={() => setShowIosGuide(false)}
                className="p-1 rounded text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              In Safari, tap the <Share className="inline w-3.5 h-3.5 text-blue-400 mx-0.5" />{' '}
              <strong>Share</strong> button and choose <strong>Add to Home Screen</strong> to launch Project Genesis in standalone mode.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowIosGuide(false)}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
