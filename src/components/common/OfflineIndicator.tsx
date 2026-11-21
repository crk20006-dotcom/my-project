import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC = () => {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-xs flex items-center justify-center gap-2 shrink-0"
    >
      <WifiOff className="w-3.5 h-3.5" />
      <span>
        Browser network is offline — local cached UI remains available; World Intelligence web retrieval requires connectivity.
      </span>
    </div>
  );
};
