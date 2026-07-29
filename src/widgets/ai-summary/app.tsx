import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Markdown from '@jetbrains/ring-ui-built/components/markdown/markdown';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig} from './types';
import {parseStoredConfig} from './types';
import {loadIssues, askAi} from './resources';
import {Configuration} from './configuration';
import './app.css';

interface AppProps {
  host: EmbeddableWidgetAPI;
}

const AppComponent: React.FC<AppProps> = ({host}) => {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState('');

  useEffect(() => {
    async function init() {
      const raw = await host.readConfig<WidgetConfig>();
      const savedConfig = parseStoredConfig(raw);
      if (!savedConfig) {
        host.enterConfigMode();
        setIsConfiguring(true);
      } else {
        setConfig(savedConfig);
        host.setTitle('AI Summary', '');
      }
      setIsReady(true);
    }
    init();
  }, [host]);

  useEffect(() => {
    const handleConfigure = () => {
      setIsConfiguring(true);
      host.enterConfigMode();
    };
    window.addEventListener('yt-widget-configure', handleConfigure);
    return () => window.removeEventListener('yt-widget-configure', handleConfigure);
  }, [host]);

  const handleSaveConfig = useCallback(async (newConfig: WidgetConfig) => {
    setConfig(newConfig);
    setIsConfiguring(false);
    setMarkdown('');
    setError(null);
    host.setTitle('AI Summary', '');
    await host.storeConfig(newConfig);
  }, [host]);

  const handleCancelConfig = useCallback(() => {
    if (!config) {
      host.removeWidget();
      return;
    }
    setIsConfiguring(false);
    host.exitConfigMode();
  }, [config, host]);

  const handleRefresh = useCallback(async () => {
    if (!config) return;
    setIsLoading(true);
    setError(null);
    host.clearError();
    host.setLoadingAnimationEnabled(true);
    try {
      const issues = await loadIssues(host, config.search);
      const result = await askAi(host, issues, config.prompt);
      setMarkdown(result);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err.message);
      host.setError(err);
    } finally {
      setIsLoading(false);
      host.setLoadingAnimationEnabled(false);
    }
  }, [config, host]);

  if (isConfiguring) {
    return (
      <Configuration
        config={config}
        onSave={handleSaveConfig}
        onCancel={handleCancelConfig}
      />
    );
  }

  if (!isReady) {
    return (
      <div className="as-center">
        <LoaderInline />
      </div>
    );
  }

  return (
    <div className="as-widget">
      <div className="as-toolbar">
        <Button primary disabled={isLoading} onClick={handleRefresh}>
          Обновить
        </Button>
        <Button
          className="as-settings-btn"
          onClick={() => {
            setIsConfiguring(true);
            host.enterConfigMode();
          }}
        >
          &#9881;
        </Button>
      </div>

      {isLoading && (
        <div className="as-center">
          <LoaderInline />
        </div>
      )}

      {error && <div className="as-error">{error}</div>}

      {!isLoading && !error && markdown && (
        <div className="as-result">
          <Markdown>{markdown}</Markdown>
        </div>
      )}
    </div>
  );
};

export const App = memo(AppComponent);
