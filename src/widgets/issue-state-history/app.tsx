import React, { useEffect } from 'react';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import './app.css';

interface Props {
  host: EmbeddableWidgetAPI;
}

export default function App({ host }: Props) {
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
