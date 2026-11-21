import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FirstRunWizard } from './components/common/FirstRunWizard';
import { LockScreen } from './components/common/LockScreen';
import { OfflineIndicator } from './components/common/OfflineIndicator';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { apiClient, setUnauthorizedHandler } from './services/apiClient';
import type { ModuleId, SystemSettings } from './types/genesis';

const GenesisChatModule = lazy(() =>
  import('./components/modules/GenesisChatModule').then((m) => ({ default: m.GenesisChatModule }))
);
const GenesisIntelligenceModule = lazy(() =>
  import('./components/modules/GenesisIntelligenceModule').then((m) => ({
    default: m.GenesisIntelligenceModule,
  }))
);
const GenesisEngineeringModule = lazy(() =>
  import('./components/modules/GenesisEngineeringModule').then((m) => ({
    default: m.GenesisEngineeringModule,
  }))
);
const GenesisAgentModule = lazy(() =>
  import('./components/modules/GenesisAgentModule').then((m) => ({ default: m.GenesisAgentModule }))
);
const GenesisResearchModule = lazy(() =>
  import('./components/modules/GenesisResearchModule').then((m) => ({
    default: m.GenesisResearchModule,
  }))
);
const GenesisLaboratoryModule = lazy(() =>
  import('./components/modules/GenesisLaboratoryModule').then((m) => ({
    default: m.GenesisLaboratoryModule,
  }))
);
const GenesisCreatorModule = lazy(() =>
  import('./components/modules/GenesisCreatorModule').then((m) => ({
    default: m.GenesisCreatorModule,
  }))
);
const GenesisMemoryModule = lazy(() =>
  import('./components/modules/GenesisMemoryModule').then((m) => ({ default: m.GenesisMemoryModule }))
);
const GenesisVoiceModule = lazy(() =>
  import('./components/modules/GenesisVoiceModule').then((m) => ({ default: m.GenesisVoiceModule }))
);
const GenesisModelManagerModule = lazy(() =>
  import('./components/modules/GenesisModelManagerModule').then((m) => ({
    default: m.GenesisModelManagerModule,
  }))
);
const GenesisSystemSettingsModule = lazy(() =>
  import('./components/modules/GenesisSystemSettingsModule').then((m) => ({
    default: m.GenesisSystemSettingsModule,
  }))
);

export default function App() {
  const [activeModule, setActiveModule] = useState<ModuleId>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [operatorName, setOperatorName] = useState('Local Operator');
  const [locked, setLocked] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);

  const loadAuthenticatedSettings = useCallback(async () => {
    const cfg = await apiClient.getSettings();
    setSettings(cfg);
    setOperatorName(cfg.operator_name || 'Local Operator');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setLocked(true);
      setAuthNotice('Session expired or locked. Enter your local passcode to continue.');
      void apiClient
        .getAuthStatus()
        .then((status) => setOperatorName(status.operator_name || 'Local Operator'))
        .catch(() => {});
    });

    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .getAuthStatus()
      .then(async (status) => {
        if (!active) return;
        setOperatorName(status.operator_name || 'Local Operator');
        if (status.local_auth_enabled && status.has_passcode && !status.authenticated) {
          setLocked(true);
          return;
        }
        await loadAuthenticatedSettings();
      })
      .catch(() => {
        // Allow UI shell to mount even if settings endpoint fails transiently
      })
      .finally(() => {
        if (active) setInitializing(false);
      });

    return () => {
      active = false;
    };
  }, [loadAuthenticatedSettings]);

  const handleUnlock = async () => {
    setAuthNotice(null);
    try {
      await loadAuthenticatedSettings();
      setLocked(false);
    } catch {
      setAuthNotice('Unable to load workspace settings after unlock. Please retry.');
    }
  };

  const handleLockWorkspace = async () => {
    try {
      await apiClient.logout();
    } catch {
      // Proceed with locking UI even if logout request fails transiently
    }
    setAuthNotice(null);
    setLocked(true);
  };

  if (initializing) {
    return (
      <div className="h-screen bg-[#0A0D12] text-slate-300 flex items-center justify-center text-sm">
        Initializing Project Genesis Core Platform...
      </div>
    );
  }

  if (locked) {
    return (
      <LockScreen
        operatorName={settings?.operator_name || operatorName}
        notice={authNotice}
        onUnlock={() => void handleUnlock()}
      />
    );
  }

  const renderModule = () => {
    switch (activeModule) {
      case 'chat':
        return <GenesisChatModule settings={settings} />;
      case 'intelligence':
        return <GenesisIntelligenceModule />;
      case 'engineering':
        return <GenesisEngineeringModule settings={settings} />;
      case 'agent':
        return <GenesisAgentModule />;
      case 'research':
        return <GenesisResearchModule />;
      case 'laboratory':
        return <GenesisLaboratoryModule />;
      case 'creator':
        return <GenesisCreatorModule />;
      case 'memory':
        return <GenesisMemoryModule />;
      case 'voice':
        return <GenesisVoiceModule settings={settings} onSettingsUpdated={setSettings} />;
      case 'models':
        return <GenesisModelManagerModule settings={settings} onSettingsUpdated={setSettings} />;
      case 'settings':
        return <GenesisSystemSettingsModule settings={settings} onSettingsUpdated={setSettings} />;
      default:
        return <GenesisChatModule settings={settings} />;
    }
  };

  return (
    <div className="h-screen w-full bg-[#0A0D12] text-slate-100 flex overflow-hidden">
      <Sidebar
        activeModule={activeModule}
        onSelectModule={setActiveModule}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <OfflineIndicator />
        <TopBar
          activeModule={activeModule}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          localAuthEnabled={Boolean(settings?.local_auth_enabled && settings?.has_passcode)}
          onLockWorkspace={() => void handleLockWorkspace()}
          preferLocalInference={Boolean(settings?.prefer_local_inference)}
        />

        <main className="flex-1 min-h-0 overflow-hidden relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeModule}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              className="h-full w-full"
            >
              <Suspense
                fallback={
                  <div className="h-full w-full flex items-center justify-center text-xs text-slate-400">
                    Loading workspace module...
                  </div>
                }
              >
                {renderModule()}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {settings && settings.first_run_completed === false && (
        <FirstRunWizard
          settings={settings}
          onCompleted={(next) => {
            setSettings(next);
            setOperatorName(next.operator_name || 'Local Operator');
          }}
        />
      )}
    </div>
  );
}
