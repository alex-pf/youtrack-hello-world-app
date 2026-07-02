import React, { useEffect, useState } from 'react';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import { WidgetConfig, parseStoredConfig } from './types';
import './app.css';

interface Props {
  host: EmbeddableWidgetAPI;
}

export default function App({ host }: Props) {
  const [config, setConfig] = useState<WidgetConfig | null>(null);

  // ─── Configure event bridge ────────────────────────────────────────────────
  useEffect(() => {
    const handleConfigure = () => {
      host.enterConfigMode();
    };
    window.addEventListener('yt-widget-configure', handleConfigure);
    return () => window.removeEventListener('yt-widget-configure', handleConfigure);
  }, [host]);

  // ─── Initialization ────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      try {
        const stored = await host.readConfig<Record<string, string>>();
        setConfig(parseStoredConfig(stored ?? {}));
        await host.clearError();
      } finally {
        await host.setLoadingAnimationEnabled(false);
      }
    }
    init();
  }, [host]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="ish-center">
      <div>Issue State History — configure me</div>
    </div>
  );
}
