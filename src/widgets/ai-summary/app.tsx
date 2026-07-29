import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Markdown from '@jetbrains/ring-ui-built/components/markdown/markdown';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, StoredWidgetConfig, Issue} from './types';
import {parseStoredConfig, serializeConfig} from './types';
import {loadIssues, askAi, describeError, dumpError} from './resources';
import {Configuration} from './configuration';
import './app.css';

interface AppProps {
  host: EmbeddableWidgetAPI;
}

interface DebugInfo {
  search: string;
  prompt: string;
  issuesCount: number;
  issues: Issue[];
  requestBody: unknown;
  rawResponse: unknown;
  rawError: string | null;
}

const AppComponent: React.FC<AppProps> = ({host}) => {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);

  useEffect(() => {
    async function init() {
      const raw = await host.readConfig<StoredWidgetConfig>();
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
    setDebugInfo(null);
    host.setTitle('AI Summary', '');
    await host.storeConfig(serializeConfig(newConfig));
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

    let issues: Issue[] = [];
    const requestBody = {prompt: config.prompt} as {prompt: string; issuesCount?: number};

    try {
      issues = await loadIssues(host, config.search);
      requestBody.issuesCount = issues.length;

      const response = await askAi(host, issues, config.prompt);

      if (response.error) {
        throw new Error(response.error);
      }

      setMarkdown(response.markdown || '');

      if (config.debugMode) {
        setDebugInfo({
          search: config.search,
          prompt: config.prompt,
          issuesCount: issues.length,
          issues,
          requestBody,
          rawResponse: response,
          rawError: null
        });
      } else {
        setDebugInfo(null);
      }
    } catch (e) {
      const message = describeError(e);
      setError(message);
      host.setError(e instanceof Error ? e : new Error(message));

      if (config.debugMode) {
        setDebugInfo({
          search: config.search,
          prompt: config.prompt,
          issuesCount: issues.length,
          issues,
          requestBody,
          rawResponse: null,
          rawError: dumpError(e)
        });
      } else {
        setDebugInfo(null);
      }
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

      {debugInfo && (
        <div className="as-debug">
          <div className="as-debug__title">Debug</div>

          <div className="as-debug__section">
            <div className="as-debug__label">Фильтр</div>
            <code>{debugInfo.search}</code>
          </div>

          <div className="as-debug__section">
            <div className="as-debug__label">Промпт</div>
            <code>{debugInfo.prompt}</code>
          </div>

          <div className="as-debug__section">
            <div className="as-debug__label">Задач загружено: {debugInfo.issuesCount}</div>
            <pre className="as-debug__pre">{JSON.stringify(debugInfo.issues, null, 2)}</pre>
          </div>

          <div className="as-debug__section">
            <div className="as-debug__label">Запрос к ask-ai/ask</div>
            <pre className="as-debug__pre">{JSON.stringify(debugInfo.requestBody, null, 2)}</pre>
          </div>

          {debugInfo.rawResponse !== null && (
            <div className="as-debug__section">
              <div className="as-debug__label">Ответ backend</div>
              <pre className="as-debug__pre">{JSON.stringify(debugInfo.rawResponse, null, 2)}</pre>
            </div>
          )}

          {debugInfo.rawError !== null && (
            <div className="as-debug__section">
              <div className="as-debug__label">Ошибка (сырые данные)</div>
              <pre className="as-debug__pre">{debugInfo.rawError}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const App = memo(AppComponent);
