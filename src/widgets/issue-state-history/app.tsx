import React, { useEffect, useState } from 'react';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import { WidgetConfig, parseStoredConfig } from './types';
import Configuration from './configuration';
import './app.css';

interface Props {
  host: EmbeddableWidgetAPI;
}

export default function App({ host }: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Configure event bridge ────────────────────────────────────────────────
  useEffect(() => {
    const handleConfigure = () => {
      setIsConfiguring(true);
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
        const parsedConfig = stored ? parseStoredConfig(stored) : null;
        setConfig(parsedConfig);
        await host.clearError();

        if (!stored?.search) {
          // No config yet — enter configuration mode
          setIsConfiguring(true);
          await host.enterConfigMode();
        }
      } finally {
        await host.setLoadingAnimationEnabled(false);
        setIsLoading(false);
      }
    }
    init();
  }, [host]);

  // ─── Config save handler ───────────────────────────────────────────────────
  const handleConfigSave = (newConfig: WidgetConfig) => {
    setConfig(newConfig);
    setIsConfiguring(false);
  };

  // ─── Config cancel handler ─────────────────────────────────────────────────
  const handleConfigCancel = () => {
    if (!config) {
      host.removeWidget();
    } else {
      setIsConfiguring(false);
      host.exitConfigMode();
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  if (isConfiguring) {
    return (
      <Configuration
        config={config}
        host={host}
        onSave={handleConfigSave}
        onCancel={handleConfigCancel}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="ish-center">
        <div>Loading...</div>
      </div>
    );
  }

  return (
    <div className="ish-center">
      <div>Issue State History — configure me</div>
    </div>
  );
}
