import React, {memo, useCallback, useEffect, useRef, useState} from 'react';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {Issue, WidgetConfig, StoredWidgetConfig} from './types';
import {parseStoredConfig, serializeConfig} from './types';
import {loadIssues, loadIssuesCount, ISSUES_PACK_SIZE} from './resources';
import {Configuration} from './configuration';
import {IssuesTable} from './issues-table';
import './app.css';

interface AppProps {
  host: EmbeddableWidgetAPI;
}

const AppComponent: React.FC<AppProps> = ({host}) => {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch issues — reusable for initial load and refresh
  const fetchIssues = useCallback(async (search: string, widgetTitle?: string, silent = false) => {
    if (!silent) setIsLoading(true);
    else setIsRefreshing(true);
    setError(null);
    try {
      const [fetchedIssues, count] = await Promise.all([
        loadIssues(host, search),
        loadIssuesCount(host, search)
      ]);
      setIssues(fetchedIssues);
      setTotalCount(count);
      setLastUpdated(new Date());

      const title = widgetTitle || search;
      const countSuffix = count > 0 ? ` (${count})` : '';
      host.setTitle(title + countSuffix, '');
    } catch (e) {
      if (!silent) {
        setError('Не удалось загрузить задачи');
        host.setError(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
      host.setLoadingAnimationEnabled(false);
    }
  }, [host]);

  // Initialize widget
  useEffect(() => {
    async function init() {
      const raw = await host.readConfig<StoredWidgetConfig>();
      const savedConfig = parseStoredConfig(raw);

      // Get YouTrack base URL via Hub services
      try {
        const services = await host.loadServices('YouTrack');
        if (services.length > 0) {
          setBaseUrl(services[0].homeUrl);
        }
      } catch {
        // Fallback — URL not available
      }

      if (!savedConfig?.search) {
        host.enterConfigMode();
        setIsConfiguring(true);
        setIsLoading(false);
      } else {
        setConfig(savedConfig);
      }
    }
    init();
  }, [host]);

  // Listen for "Edit" button click from the widget toolbar
  useEffect(() => {
    const handleConfigure = () => {
      setIsConfiguring(true);
      host.enterConfigMode();
    };
    window.addEventListener('yt-widget-configure', handleConfigure);
    return () => {
      window.removeEventListener('yt-widget-configure', handleConfigure);
    };
  }, [host]);

  // Load issues when config changes
  useEffect(() => {
    if (!config?.search) return;
    fetchIssues(config.search, config.title);
  }, [config, fetchIssues]);

  // Auto-refresh timer
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (config?.search && config.refreshInterval && config.refreshInterval > 0) {
      const ms = config.refreshInterval * 60 * 1000;
      refreshTimerRef.current = setInterval(() => {
        fetchIssues(config.search, config.title, true);
      }, ms);
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [config?.search, config?.title, config?.refreshInterval, fetchIssues]);

  const handleRefresh = useCallback(() => {
    if (!config?.search || isRefreshing) return;
    fetchIssues(config.search, config.title, true);
  }, [config, isRefreshing, fetchIssues]);

  const handleLoadMore = useCallback(async () => {
    if (!config?.search || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const moreIssues = await loadIssues(host, config.search, issues.length);
      setIssues(prev => [...prev, ...moreIssues]);
    } catch {
      // Silently fail on load more
    } finally {
      setIsLoadingMore(false);
    }
  }, [config, host, issues.length, isLoadingMore]);

  const handleSaveConfig = useCallback(async (newConfig: WidgetConfig) => {
    setConfig(newConfig);
    setIsConfiguring(false);
    // storeConfig persists to server and exits config mode automatically
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

  // Configuration mode
  if (isConfiguring) {
    return (
      <Configuration
        config={config}
        host={host}
        onSave={handleSaveConfig}
        onCancel={handleCancelConfig}
      />
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="hw-center">
        <LoaderInline />
      </div>
    );
  }

  // Error state
  if (error) {
    return <div className="hw-error">{error}</div>;
  }

  // Empty state
  if (issues.length === 0) {
    return <div className="hw-empty">Задачи не найдены</div>;
  }

  const remainingCount = totalCount - issues.length;

  const formatTime = (d: Date) => {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  };

  return (
    <div className="hw-issues-list">
      <div className="hw-toolbar">
        <span className="hw-last-updated">
          {lastUpdated && `Обновлено в ${formatTime(lastUpdated)}`}
          {config?.refreshInterval ? ` · каждые ${config.refreshInterval} мин.` : ''}
        </span>
        <button
          className="hw-refresh-btn"
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="Обновить данные"
        >
          {isRefreshing ? '⟳' : '↻'} Обновить
        </button>
      </div>

      <IssuesTable
        issues={issues}
        baseUrl={baseUrl}
        visibleFields={config?.visibleFields}
      />

      {remainingCount > 0 && !isLoadingMore && (
        <div className="hw-load-more" onClick={handleLoadMore}>
          Загрузить ещё {remainingCount} {remainingCount === 1 ? 'задачу' : remainingCount < 5 ? 'задачи' : 'задач'}
        </div>
      )}

      {isLoadingMore && (
        <div className="hw-center">
          <LoaderInline />
        </div>
      )}
    </div>
  );
};

export const App = memo(AppComponent);
