import React from 'react';
import { Lock, Menu } from 'lucide-react';
import type { ModuleId } from '../../types/genesis';
import { PWAInstallButton } from '../common/PWAInstallButton';
import { GENESIS_MODULES } from './Sidebar';

interface TopBarProps {
  activeModule: ModuleId;
  onOpenMobileMenu: () => void;
  localAuthEnabled: boolean;
  onLockWorkspace: () => void;
  preferLocalInference: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeModule,
  onOpenMobileMenu,
  localAuthEnabled,
  onLockWorkspace,
  preferLocalInference,
}) => {
  const current = GENESIS_MODULES.find((m) => m.id === activeModule);

  return (
    <header className="h-14 px-4 lg:px-6 border-b border-white/[0.08] bg-[#0C1017] flex items-center justify-between gap-4 shrink-0">
      {/* Left Zone: Mobile drawer trigger + Breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-500 whitespace-nowrap hidden sm:inline">Project Genesis</span>
          <span className="text-slate-600 hidden sm:inline" aria-hidden="true">/</span>
          <h1 className="font-display font-semibold text-slate-100 truncate">
            {current?.label || 'Genesis'}
          </h1>
        </div>
      </div>

      {/* Right Zone: Quiet mode indicator + PWA Install + optional Lock button */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-xs text-slate-400 whitespace-nowrap hidden md:inline">
          {preferLocalInference ? 'Local Inference Configured' : 'Demo Mode · No Model Loaded'}
        </span>

        <PWAInstallButton />

        {localAuthEnabled && (
          <button
            type="button"
            onClick={onLockWorkspace}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] bg-[#141A24] hover:bg-[#1A2230] text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Lock className="w-3.5 h-3.5 text-slate-400" />
            <span>Lock Session</span>
          </button>
        )}
      </div>
    </header>
  );
};
