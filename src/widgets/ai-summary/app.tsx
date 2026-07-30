import React, {memo, useCallback, useEffect, useMemo, useState} from 'react';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, StoredWidgetConfig, Issue, HistoryDigest} from './types';
import {parseStoredConfig, serializeConfig} from './types';
import {loadIssues, loadIssuesHistory, askAi, describeError, dumpError} from './resources';
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
  history: HistoryDigest;
  requestBody: unknown;
  rawResponse: unknown;
  rawError: string | null;
}

const AppComponent: React.FC<AppProps> = ({host}) => {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState('');
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
        host.setTitle(savedConfig.title || 'AI Summary', '');
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
    host.setTitle(newConfig.title || 'AI Summary', '');
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
    let history: HistoryDigest = {};
    const requestBody = {prompt: config.prompt} as {prompt: string; issuesCount?: number};

    try {
      setLoadingPhase('Загрузка задач...');
      issues = await loadIssues(host, config.search);
      requestBody.issuesCount = issues.length;

      setLoadingPhase(`Загрузка истории задач (${issues.length})...`);
      history = await loadIssuesHistory(host, issues, config.includeComments);

      setLoadingPhase('Запрос к AI...');
      const response = await askAi(host, issues, config.prompt, history, {
        onTick: elapsedMs => setLoadingPhase(`Ждём ответ AI... (${Math.round(elapsedMs / 1000)}с)`)
      });

      if (response.status === 'error') {
        throw new Error(response.error || 'unknown error');
      }

      setMarkdown(response.markdown || '');

      if (config.debugMode) {
        setDebugInfo({
          search: config.search,
          prompt: config.prompt,
          issuesCount: issues.length,
          issues,
          history,
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
          history,
          requestBody,
          rawResponse: null,
          rawError: dumpError(e)
        });
      } else {
        setDebugInfo(null);
      }
    } finally {
      setIsLoading(false);
      setLoadingPhase('');
      host.setLoadingAnimationEnabled(false);
    }
  }, [config, host]);

  const markdownHtml = useMemo(
    () => markdown ? DOMPurify.sanitize(marked(markdown) as string) : '',
    [markdown]
  );

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

      <div className="as-scroll">
        {config?.description && (
          <div className="as-description">{config.description}</div>
        )}

        {isLoading && (
          <div className="as-center as-center--column">
            <LoaderInline />
            {loadingPhase && <div className="as-loading-phase">{loadingPhase}</div>}
          </div>
        )}

        {error && <div className="as-error">{error}</div>}

        {!isLoading && !error && markdown && (
          <div
            className="as-result ring-heading-contentWithHeadings ring-link-withLinks"
            dangerouslySetInnerHTML={{__html: markdownHtml}}
          />
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
              <div className="as-debug__label">История задач (сжатый дайджест, отправляется в waibee)</div>
              <pre className="as-debug__pre">{JSON.stringify(debugInfo.history, null, 2)}</pre>
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
    </div>
  );
};

export const App = memo(AppComponent);
