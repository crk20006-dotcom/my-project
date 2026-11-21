import React from 'react';
import {
  Bot,
  BookOpen,
  Boxes,
  Compass,
  Cpu,
  Database,
  FlaskConical,
  Layers,
  MessageSquare,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
} from 'lucide-react';
import type { ModuleId } from '../../types/genesis';

export interface NavModuleItem {
  id: ModuleId;
  label: string;
  shortLabel: string;
  group: 'Workspace' | 'Architecture & Lab' | 'System';
  icon: React.ComponentType<{ className?: string }>;
}

export const GENESIS_MODULES: NavModuleItem[] = [
  { id: 'chat', label: 'Genesis Chat', shortLabel: 'Chat', group: 'Workspace', icon: MessageSquare },
  { id: 'research', label: 'Genesis Research', shortLabel: 'Research', group: 'Workspace', icon: BookOpen },
  { id: 'creator', label: 'Genesis Creator', shortLabel: 'Creator', group: 'Workspace', icon: Layers },
  { id: 'memory', label: 'Genesis Memory', shortLabel: 'Memory', group: 'Workspace', icon: Database },
  { id: 'voice', label: 'Genesis Voice', shortLabel: 'Voice', group: 'Workspace', icon: Mic },
  { id: 'intelligence', label: 'Genesis Intelligence', shortLabel: 'Intelligence', group: 'Architecture & Lab', icon: Cpu },
  { id: 'engineering', label: 'Genesis Engineering', shortLabel: 'Engineering', group: 'Architecture & Lab', icon: Compass },
  { id: 'agent', label: 'Genesis Agent', shortLabel: 'Agent', group: 'Architecture & Lab', icon: Bot },
  { id: 'laboratory', label: 'Genesis Laboratory', shortLabel: 'Laboratory', group: 'Architecture & Lab', icon: FlaskConical },
  { id: 'models', label: 'Genesis Model Manager', shortLabel: 'Models', group: 'System', icon: Boxes },
  { id: 'settings', label: 'Genesis System Settings', shortLabel: 'Settings', group: 'System', icon: Settings },
];

interface SidebarProps {
  activeModule: ModuleId;
  onSelectModule: (id: ModuleId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeModule,
  onSelectModule,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
}) => {
  const groups: Array<'Workspace' | 'Architecture & Lab' | 'System'> = [
    'Workspace',
    'Architecture & Lab',
    'System',
  ];

  const handleSelect = (id: ModuleId) => {
    onSelectModule(id);
    onCloseMobile();
  };

  const sidebarContent = (isMobile: boolean) => (
    <div className="flex flex-col h-full bg-[#0E131B] border-r border-white/[0.08] select-none">
      {/* Brand Header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-white/[0.06] shrink-0">
        {(!collapsed || isMobile) && (
          <div className="flex items-center gap-2.5 min-w-0">
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5 text-blue-400 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="font-display font-semibold text-sm tracking-tight text-slate-100 whitespace-nowrap truncate">
              Genesis
            </span>
          </div>
        )}

        {isMobile ? (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors cursor-pointer ${
              collapsed ? 'mx-auto' : ''
            }`}
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        )}
      </div>

      {/* Navigation Modules */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-5" aria-label="Genesis Modules">
        {groups.map((group) => {
          const items = GENESIS_MODULES.filter((m) => m.group === group);
          return (
            <div key={group}>
              {(!collapsed || isMobile) && (
                <div className="px-2.5 pb-1.5 text-[11px] font-medium text-slate-500">
                  {group}
                </div>
              )}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeModule === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelect(item.id)}
                      title={collapsed && !isMobile ? item.label : undefined}
                      className={`w-full flex items-center gap-2.5 px-2.5 min-h-[40px] rounded-lg text-[13.5px] transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-blue-500/12 text-blue-300 font-medium'
                          : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]'
                      } ${collapsed && !isMobile ? 'justify-center px-0' : ''}`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-blue-400' : 'text-slate-400'}`} />
                      {(!collapsed || isMobile) && (
                        <span className="truncate whitespace-nowrap">{item.label}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Honest Platform Boundary Footer */}
      {(!collapsed || isMobile) && (
        <div className="px-4 py-3 border-t border-white/[0.06] text-[11.5px] text-slate-500 leading-snug shrink-0">
          <div className="text-slate-300 font-medium">Step 01 · Demo Mode</div>
          <div>Local SQLite · No external AI API</div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop Collapsible Rail */}
      <aside
        className={`hidden lg:block shrink-0 transition-[width] duration-150 ease-out ${
          collapsed ? 'w-[64px]' : 'w-[252px]'
        }`}
      >
        {sidebarContent(false)}
      </aside>

      {/* Mobile Slide-Over Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative w-[272px] max-w-[85vw] h-full z-10">
            {sidebarContent(true)}
          </aside>
        </div>
      )}
    </>
  );
};
