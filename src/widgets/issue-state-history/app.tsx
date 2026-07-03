import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import Configuration from './configuration';
import { WidgetConfig, IssueStateHistoryData, IssueActivityItem, Issue, ChildIssueRef, parseStoredConfig } from './types';
import { loadIssuesWithActivities, loadIssuesCount, extractCurrentEstimatedDate } from './resources';
import { buildIssueStateHistoryData, getDebugTransitionTimeline, getDebugBlockingInfo, getDebugChildLinkInfo } from './activity-parser';
import GanttChart from './gantt-chart';
import './app.css';

interface Props {
  host: EmbeddableWidgetAPI;
}

// ─── Indicator toggle panel ─────────────────────────────────────────────────
// Session-level (not persisted to config) registry of indicator TYPES the
// user can independently show/hide. Keyed by ChartIndicator.semanticType.
// Each future indicator producer (Task 3: estimate flag, Task 4: blocking
// hatch) should add one entry here with its own semanticType + label — the
// checkbox panel below is driven entirely off this list, so no other app.tsx
// changes are needed to add a new toggle.
interface IndicatorTypeOption {
  semanticType: string;
  label: string;
}

const INDICATOR_TYPE_OPTIONS: IndicatorTypeOption[] = [
  { semanticType: 'estimate-date-change', label: 'Estimate Date change' },
  { semanticType: 'estimate-date-current', label: 'Current Estimate Date' },
  { semanticType: 'blocking', label: 'Blocking periods' },
  { semanticType: 'child-link-change', label: 'Child issues added/removed' },
];

export default function App({ host }: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [chartData, setChartData] = useState<IssueStateHistoryData[]>([]);
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
  const [debugCurrentChildrenMap, setDebugCurrentChildrenMap] = useState<Map<string, ChildIssueRef[]>>(new Map());
  // Indicator visibility toggles — session-only, defaults to all types visible.
  const [visibleIndicatorTypes, setVisibleIndicatorTypes] = useState<Set<string>>(
    () => new Set(INDICATOR_TYPE_OPTIONS.map((o) => o.semanticType))
  );

  const toggleIndicatorType = useCallback((semanticType: string) => {
    setVisibleIndicatorTypes((prev) => {
      const next = new Set(prev);
      if (next.has(semanticType)) {
        next.delete(semanticType);
      } else {
        next.add(semanticType);
      }
      return next;
    });
  }, []);

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
      const title = cfg.title || 'Issue State History';
      // YouTrack returns -1 when count is still calculating
      const countLabel = count >= 0 ? ` (${count})` : '';
      await host.setTitle(`${title}${countLabel}`, '');

      // Load issues + activities + current child issues with progress updates
      const { issues, activitiesMap, currentChildrenMap } = await loadIssuesWithActivities(
        host,
        cfg.search,
        (phase, loaded, total) => {
          if (!silent) {
            if (phase === 'issues') {
              setLoadingMessage(`Loading issues... ${loaded}`);
            } else if (phase === 'activities') {
              setLoadingMessage(`Loading history... ${loaded}/${total}`);
            } else {
              setLoadingMessage(`Loading child issues... ${loaded}/${total}`);
            }
          }
        }
      );

      // Build chart data from parsed activities
      const data = buildIssueStateHistoryData(issues, activitiesMap, cfg.statusOrder, currentChildrenMap);

      setChartData(data);
      // Persist raw data for debug mode
      setDebugIssues(issues);
      setDebugActivitiesMap(activitiesMap);
      setDebugCurrentChildrenMap(currentChildrenMap);
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
        const parsedConfig = stored ? parseStoredConfig(stored) : null;
        setConfig(parsedConfig);
        configRef.current = parsedConfig;

        if (!stored?.search) {
          // No config yet — enter configuration mode
          setIsConfiguring(true);
          await host.enterConfigMode();
          setIsLoading(false);
          return;
        }
        await fetchData(parsedConfig!, false);
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
      <div className="ish-center">
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
      <div className="ish-center">
        <div>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>Failed to load data</div>
          <div style={{ fontSize: 'var(--ring-font-size-smaller)' }}>{error}</div>
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="ish-center">
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
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '2px 8px',
        gap: 8,
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 'var(--ring-font-size-smaller)',
          color: 'var(--ring-text-color)',
        }}>
          {INDICATOR_TYPE_OPTIONS.map((opt) => (
            <label
              key={opt.semanticType}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={visibleIndicatorTypes.has(opt.semanticType)}
                onChange={() => toggleIndicatorType(opt.semanticType)}
                style={{ margin: 0, cursor: 'pointer' }}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
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
          Обновить
        </button>
        </div>
      </div>

      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <GanttChart
          data={chartData}
          statusOrder={config?.statusOrder ?? []}
          baseUrl={baseUrl}
          gridStep={config?.gridStep ?? 'day'}
          visibleIndicatorTypes={visibleIndicatorTypes}
        />
      </div>

      {/* Markdown description — fixed below chart, sized to content */}
      {descriptionHtml && (
        <div
          className="ish-description"
          dangerouslySetInnerHTML={{__html: descriptionHtml}}
        />
      )}

      {/* Debug: status transition history */}
      {config?.debugMode && (
        <div className="ish-debug">
          <div className="ish-debug__title">Debug: status transition history</div>
          {chartData.map((issue) => {
            const issueObj = debugIssues.find((i) => i.id === issue.issueId);
            const activities = debugActivitiesMap.get(issue.issueId) ?? [];
            const timeline = getDebugTransitionTimeline(
              activities,
              issueObj?.created ?? Date.now()
            );
            return (
              <div key={issue.issueId} className="ish-debug__issue">
                <div className="ish-debug__issue-title">
                  <strong>{issue.idReadable}</strong>
                  {': '}
                  {issue.summary}
                  {issue.neverReachedStartStatus && (
                    <span className="ish-debug__flag"> (never reached start status)</span>
                  )}
                </div>
                {(() => {
                  const dateField = issueObj?.fields.find((f) => {
                    const fieldName = f.projectCustomField?.field?.name?.toLowerCase() ?? '';
                    return fieldName.includes('estimated') || fieldName.includes('due date') || fieldName.includes('deadline');
                  });
                  const extracted = issueObj ? extractCurrentEstimatedDate(issueObj) : null;
                  return (
                    <div className="ish-debug__estimate">
                      Estimated Date raw field: <code>{dateField ? JSON.stringify(dateField.value) : 'field not found'}</code>
                      {' → extracted: '}
                      <code>{extracted !== null ? new Date(extracted).toISOString() : 'null'}</code>
                    </div>
                  );
                })()}
                {(() => {
                  const estimateChangeActivities = activities.filter((a) => {
                    const fieldName = a.field?.name?.toLowerCase() ?? '';
                    return fieldName.includes('estimated') || fieldName.includes('due date') || fieldName.includes('deadline');
                  });
                  if (estimateChangeActivities.length === 0) return null;
                  return (
                    <div className="ish-debug__estimate">
                      Estimated Date change activities (raw added/removed):
                      <br />
                      <code>{JSON.stringify(estimateChangeActivities.map((a) => ({ timestamp: a.timestamp, added: a.added, removed: a.removed })))}</code>
                    </div>
                  );
                })()}
                {(() => {
                  // Debug for the Task 4 blocking-period heuristic — UNTESTED
                  // against real project data, see activity-parser.ts doc
                  // comment above buildBlockingIndicators(). Surfaces which
                  // field (if any) matched the /blocked|блокирован/i and
                  // /reason|причина|blocker/i name regexes, plus the raw
                  // transitions/intervals/reason sub-periods derived from
                  // them, so a mismatch against the real field names/shapes
                  // can be diagnosed and reported.
                  const blockingInfo = getDebugBlockingInfo(activities, issueObj?.resolved ?? null);
                  return (
                    <div className="ish-debug__estimate">
                      Blocked field: <code>{blockingInfo.blockedFieldName ?? 'not found'}</code>
                      {' | '}
                      Reason field: <code>{blockingInfo.reasonFieldName ?? 'not found'}</code>
                      <br />
                      Transitions: <code>{JSON.stringify(blockingInfo.transitions)}</code>
                      <br />
                      Intervals: <code>{JSON.stringify(blockingInfo.intervals)}</code>
                      <br />
                      Reason sub-periods per interval: <code>{JSON.stringify(blockingInfo.subPeriodsByInterval)}</code>
                    </div>
                  );
                })()}
                {(() => {
                  // Debug for the child-issues-indicator feature — UNTESTED
                  // against real project data, see activity-parser.ts doc
                  // comment above filterChildLinkActivities(). Surfaces the
                  // raw LinksCategory activities found, which of them passed
                  // the "Родитель для"/"Subtask" outward-direction filter,
                  // and the derived change events + current children
                  // snapshot, so a mismatch against real API field names/
                  // shapes can be diagnosed and reported.
                  const currentChildren = debugCurrentChildrenMap.get(issue.issueId) ?? [];
                  const childLinkInfo = getDebugChildLinkInfo(activities, currentChildren);
                  return (
                    <div className="ish-debug__estimate">
                      Current children: <code>{JSON.stringify(childLinkInfo.currentChildren)}</code>
                      <br />
                      Raw LinksCategory activities: <code>{JSON.stringify(childLinkInfo.rawLinkActivities)}</code>
                      <br />
                      Filtered (parent-for-subtask) activities: <code>{JSON.stringify(childLinkInfo.filteredActivities)}</code>
                      <br />
                      Derived change events: <code>{JSON.stringify(childLinkInfo.changes)}</code>
                    </div>
                  );
                })()}
                {timeline.length === 0 ? (
                  <div className="ish-debug__no-history">No transition data</div>
                ) : (
                  <ol className="ish-debug__transitions">
                    {timeline.map((entry, idx) => (
                      <li key={idx} className="ish-debug__transition">
                        <span className="ish-debug__date">
                          {new Date(entry.timestamp).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                          })}
                        </span>
                        <span className="ish-debug__arrow"> → </span>
                        <span className="ish-debug__status">{entry.stateName}</span>
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
