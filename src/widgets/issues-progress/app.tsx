import React, { useEffect, useRef, useState } from 'react';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import Configuration from './configuration';
import GanttChart from './gantt-chart';
import { WidgetConfig, IssueChartData, parseStoredConfig } from './types';
import { loadIssuesWithActivities, loadIssuesCount } from './resources';
import { buildChartData } from './activity-parser';
import './app.css';

interface Props {
  host: EmbeddableWidgetAPI;
}

export default function App({ host }: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [chartData, setChartData] = useState<IssueChartData[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Loading issues...');
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        // Load base URL for issue links
        const services = await host.loadServices('YouTrack');
        if (services?.[0]?.homeUrl) {
          setBaseUrl(services[0].homeUrl);
        }

        // Load saved config
        const stored = await host.readConfig<Record<string, string>>();
        if (!stored?.search) {
          // No config yet — enter configuration mode
          setIsConfiguring(true);
          await host.enterConfigMode();
          setIsLoading(false);
          return;
        }

        const parsedConfig = parseStoredConfig(stored);
        setConfig(parsedConfig);
        await fetchData(parsedConfig, false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        await host.setError(e as Error);
      } finally {
        await host.setLoadingAnimationEnabled(false);
        setIsLoading(false);
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // ─── Auto-refresh ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (config?.refreshInterval && config.refreshInterval > 0) {
      const intervalMs = config.refreshInterval * 60 * 1000;
      refreshTimerRef.current = setInterval(() => {
        fetchData(config, true);
      }, intervalMs);
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.refreshInterval]);

  // ─── Data fetching ─────────────────────────────────────────────────────────
  async function fetchData(cfg: WidgetConfig, silent: boolean) {
    if (!silent) {
      setIsLoading(true);
      setError(null);
    } else {
      setIsRefreshing(true);
    }

    try {
      await host.clearError();

      // Load total count for title
      const count = await loadIssuesCount(host, cfg.search);
      setTotalCount(count);

      // Update widget title
      const title = cfg.title || 'Issues Progress';
      await host.setTitle(`${title} (${count})`, '');

      // Load issues + activities with progress updates
      const { issues, activitiesMap } = await loadIssuesWithActivities(
        host,
        cfg.search,
        (phase, loaded, total) => {
          if (!silent) {
            if (phase === 'issues') {
              setLoadingMessage(`Loading issues... ${loaded}`);
            } else {
              setLoadingMessage(`Loading history... ${loaded}/${total}`);
            }
          }
        }
      );

      // Build chart data from parsed activities
      const data = buildChartData(
        issues,
        activitiesMap,
        cfg.statusOrder,
        cfg.showEstimateDate
      );

      setChartData(data);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      await host.setError(e as Error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  // ─── Config save handler ───────────────────────────────────────────────────
  const handleConfigSave = async (newConfig: WidgetConfig) => {
    setConfig(newConfig);
    setIsConfiguring(false);
    setIsLoading(true);
    await fetchData(newConfig, false);
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
      <div className="ip-center">
        <div style={{ textAlign: 'center' }}>
          <LoaderInline />
          <div style={{
            marginTop: '8px',
            fontSize: 'var(--ring-font-size-smaller)',
            color: 'var(--ring-secondary-color)'
          }}>
            {loadingMessage}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ip-error">
        <div>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>Failed to load data</div>
          <div style={{ fontSize: 'var(--ring-font-size-smaller)' }}>{error}</div>
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="ip-empty">
        <div>
          <div style={{ marginBottom: '4px' }}>No issues found</div>
          <div style={{ fontSize: 'var(--ring-font-size-smaller)' }}>
            {config?.search
              ? `No issues match the query: "${config.search}"`
              : 'Configure a search query to display issues.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {/* Refresh indicator */}
      {isRefreshing && (
        <div style={{
          position: 'absolute',
          top: 4,
          right: 8,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 'var(--ring-font-size-smaller)',
          color: 'var(--ring-secondary-color)',
        }}>
          <LoaderInline />
          <span>Refreshing...</span>
        </div>
      )}

      {/* Gantt chart */}
      <GanttChart
        data={chartData}
        statusOrder={config?.statusOrder ?? []}
        ltEnabled={config?.ltEnabled ?? false}
        ltSettings={config?.ltSettings ?? {}}
        showEstimateDate={config?.showEstimateDate ?? false}
        baseUrl={baseUrl}
      />
    </div>
  );
}