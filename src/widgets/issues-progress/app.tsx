import React, {useEffect, useState} from 'react';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import Configuration from './configuration';
import {WidgetConfig, parseStoredConfig} from './types';

interface Props {
  host: EmbeddableWidgetAPI;
}

export default function App({host}: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);

  useEffect(() => {
    const handleConfigure = () => {
      setIsConfiguring(true);
      host.enterConfigMode();
    };
    window.addEventListener('yt-widget-configure', handleConfigure);

    async function init() {
      const stored = await host.readConfig<Record<string, string>>();
      if (!stored?.search) {
        setIsConfiguring(true);
        await host.enterConfigMode();
      } else {
        setConfig(parseStoredConfig(stored));
      }
      await host.setLoadingAnimationEnabled(false);
    }
    init();

    return () => window.removeEventListener('yt-widget-configure', handleConfigure);
  }, [host]);

  if (isConfiguring) {
    return (
      <Configuration
        config={config}
        host={host}
        onSave={(newConfig) => {
          setConfig(newConfig);
          setIsConfiguring(false);
        }}
        onCancel={() => {
          if (!config) {
            host.removeWidget();
          } else {
            setIsConfiguring(false);
            host.exitConfigMode();
          }
        }}
      />
    );
  }

  return (
    <div style={{padding: '16px', color: 'var(--ring-text-color)'}}>
      <h3>Issues Progress &amp; Lead Time Tracker</h3>
      <p>Widget configured. Full visualization coming in Phase 5.</p>
      {config && <pre style={{fontSize: '11px'}}>{JSON.stringify(config, null, 2)}</pre>}
    </div>
  );
}