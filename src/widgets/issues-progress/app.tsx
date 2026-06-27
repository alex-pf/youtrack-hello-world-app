import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import Configuration from './configuration';
import GanttChart from './gantt-chart';
import { WidgetConfig, IssueChartData, IssueActivityItem, Issue, parseStoredConfig } from './types';
import { loadIssuesWithActivities, loadIssuesCount } from './resources';
import { buildChartData, parseStateTimeline } from './activity-parser';
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
  // Ref to always have the latest config inside setInterval closure
  const configRef = useRef<WidgetConfig | null>(null);
  // Raw data kept for debug mode rendering
  const [debugIssues, setDebugIssues] = useState<Issue[]>([]);
  const [debugActivitiesMap, setDebugActivitiesMap] = useState<Map<string, IssueActivityItem[]>>(new Map());

  // ─── Configure event bridge ────────────────────────────────────────────────
  useEffect(() => {
    const handleConfigure = () => {
      setIsConfiguring(true);
      host.enterConfigMode();
    };
    window.addEventListener('yt-widget-configure', handleConfigure);
    return () => window.removeEventListener('yt-widget-configure', handleConfigure);
  }, [host]);

  // ─── Data fetching ─────────────────────────────────────────────────────────
  const fetchData = useCallback(async (cfg: WidgetConfig, silent: boolean) => {
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
      // YouTrack returns -1 when count is still calculating
      const countLabel = count >= 0 ? ` (${count})` : '';
      await host.setTitle(`${title}${countLabel}`, '');

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
        cfg.showEstimateDate,
        cfg.showProjectedLT ?? false
      );

      setChartData(data);
      // Persist raw data for debug mode
      setDebugIssues(issues);
      setDebugActivitiesMap(activitiesMap);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      await host.setError(e as Error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [host]);

  // ─── Initialization ────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      try {
        // Load base URL for issue links
        const services = await host.loadServices('YouTrack');
        if (services?.[0]?.homeUrl) {
          setBaseUrl(services[0].homeUrl);
        } else {
          console.warn('YouTrack homeUrl not found, issue links will be relative');
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
        configRef.current = parsedConfig;
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
  }, [host, fetchData]);

  // ─── Auto-refresh ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (config?.refreshInterval && config.refreshInterval > 0) {
      const intervalMs = config.refreshInterval * 60 * 1000;
      refreshTimerRef.current = setInterval(() => {
        if (configRef.current) {
          fetchData(configRef.current, true);
        }
      }, intervalMs);
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [config?.refreshInterval, fetchData]);

  // ─── Config save handler ───────────────────────────────────────────────────
  const handleConfigSave = async (newConfig: WidgetConfig) => {
    setConfig(newConfig);
    configRef.current = newConfig;
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

  // ─── Derived render values (hooks must be before early returns) ───────────
  const sortedData = useMemo(
    () => [...chartData].sort((a, b) => {
      const aDate = a.estimateDateChanges.length > 0
        ? Math.max(...a.estimateDateChanges.map(c => c.changedAt))
        : Infinity;
      const bDate = b.estimateDateChanges.length > 0
        ? Math.max(...b.estimateDateChanges.map(c => c.changedAt))
        : Infinity;
      return aDate - bDate;
    }),
    [chartData]
  );

  const descriptionHtml = useMemo(
    () => config?.description
      ? DOMPurify.sanitize(marked(config.description) as string)
      : '',
    [config?.description]
  );

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
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateRows: 'auto 1fr auto', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        padding: '2px 8px',
        gap: 8,
        flexShrink: 0,
      }}>
        {isRefreshing && (
          <div style={{
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
        <button
          onClick={() => config && fetchData(config, true)}
          disabled={isRefreshing}
          style={{
            background: 'none',
            border: '1px solid var(--ring-borders-color)',
            borderRadius: 4,
            padding: '2px 10px',
            cursor: isRefreshing ? 'default' : 'pointer',
            fontSize: 'var(--ring-font-size-smaller)',
            color: 'var(--ring-text-color)',
            opacity: isRefreshing ? 0.5 : 1,
          }}
        >
          Refresh
        </button>
      </div>

      {/* Gantt chart — scrollable, takes all remaining space */}
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <GanttChart
          data={sortedData}
          statusOrder={config?.statusOrder ?? []}
          ltEnabled={config?.ltEnabled ?? false}
          ltSettings={config?.ltSettings ?? {}}
          showEstimateDate={config?.showEstimateDate ?? false}
          showProjectedLT={config?.showProjectedLT ?? false}
          baseUrl={baseUrl}
        />
      </div>

      {/* Markdown description — fixed below chart, sized to content */}
      {descriptionHtml && (
        <div
          className="ip-description"
          dangerouslySetInnerHTML={{__html: descriptionHtml}}
        />
      )}

      {/* Debug: status transition history */}
      {config?.debugMode && (
        <div className="ip-debug">
          <div className="ip-debug__title">Debug: status transition history</div>
          {chartData.map((issue) => {
            const issueObj = debugIssues.find((i) => i.id === issue.issueId);
            const activities = debugActivitiesMap.get(issue.issueId) ?? [];
            const timeline = parseStateTimeline(
              activities,
              issueObj?.created ?? Date.now()
            );
            return (
              <div key={issue.issueId} className="ip-debug__issue">
                <div className="ip-debug__issue-title">
                  <strong>{issue.idReadable}</strong>
                  {': '}
                  {issue.summary}
                </div>
                {timeline.length === 0 ? (
                  <div className="ip-debug__no-history">No transition data</div>
                ) : (
                  <ol className="ip-debug__transitions">
                    {timeline.map((entry, idx) => (
                      <li key={idx} className="ip-debug__transition">
                        <span className="ip-debug__date">
                          {new Date(entry.timestamp).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                          })}
                        </span>
                        <span className="ip-debug__arrow"> → </span>
                        <span className="ip-debug__status">{entry.stateName}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
