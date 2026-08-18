import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Select, { type SelectItem } from '@jetbrains/ring-ui-built/components/select/select';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { EmbeddableWidgetAPI } from '../../../@types/globals';
import Configuration from './configuration';
import GroupedGanttChart from './grouped-gantt-chart';
import { WidgetConfig, IssueChartData, IssueActivityItem, Issue, parseStoredConfig, flattenStages } from './types';
import { loadIssuesWithActivities, loadIssuesCount } from './resources';
import { buildChartData, groupChartData, parseStateTimeline, findLeadTimeStartAt } from './activity-parser';
import { fetchGroupPercentiles } from './percentiles';
import './app.css';

interface Props {
  host: EmbeddableWidgetAPI;
}

/**
 * Combines the primary and additional search filters into a single YouTrack
 * query used to determine chart composition — see
 * docs/PROGRESS_TRACKING_SPEC.md section 8, assumption 3.
 */
function buildCombinedQuery(primarySearch: string, additionalSearch: string): string {
  const additional = additionalSearch.trim();
  return additional ? `(${primarySearch}) and (${additional})` : primarySearch;
}

export default function App({ host }: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [chartData, setChartData] = useState<IssueChartData[]>([]);
  const [groups, setGroups] = useState<Map<string, IssueChartData[]>>(new Map());
  const [percentilesByGroup, setPercentilesByGroup] = useState<Map<string, { p50: number; p80: number } | null>>(new Map());
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
  // Live stage selector (toolbar) — see docs/PROGRESS_TRACKING_SPEC.md section
  // 11.4. Not persisted to config; init/config-save reset it to
  // config.percentileStageId, while auto-refresh/manual-refresh leave it as-is.
  const [selectedStageId, setSelectedStageIdState] = useState<string>('');
  const selectedStageIdRef = useRef<string>('');
  const setSelectedStageId = (id: string) => {
    selectedStageIdRef.current = id;
    setSelectedStageIdState(id);
  };
  const [isRecomputingPercentiles, setIsRecomputingPercentiles] = useState(false);
  // Per-stage percentile cache, populated eagerly: the selected stage is
  // computed inline during fetchData, all other non-empty stages are
  // computed afterwards in the background (see precomputeOtherStages), so
  // switching stages in the toolbar is instant once the background pass
  // catches up instead of re-fetching on every click.
  const [percentileCache, setPercentileCache] = useState<Map<string, Map<string, { p50: number; p80: number } | null>>>(new Map());
  const percentileCacheRef = useRef<Map<string, Map<string, { p50: number; p80: number } | null>>>(new Map());
  // Bumped on every fetchData call; the background precompute loop checks
  // this before writing each stage's result so a stale background pass from
  // a superseded fetch (config change, auto-refresh) discards its results
  // instead of overwriting fresher data.
  const dataGenerationRef = useRef(0);

  // ─── Configure event bridge ────────────────────────────────────────────────
  useEffect(() => {
    const handleConfigure = () => {
      setIsConfiguring(true);
      host.enterConfigMode();
    };
    window.addEventListener('yt-widget-configure', handleConfigure);
    return () => window.removeEventListener('yt-widget-configure', handleConfigure);
  }, [host]);

  // ─── Background percentile precompute ──────────────────────────────────────
  // Runs after fetchData resolves the selected stage's percentiles. Walks
  // every other non-empty stage sequentially (one REST round-trip set at a
  // time, not all at once — see percentiles.ts for why a single stage's
  // fetch can already be expensive when additionalSearch is set) and caches
  // each result as it lands, so a later toolbar switch is instant instead of
  // repeating the fetch on click.
  const precomputeOtherStages = useCallback(async (
    cfg: WidgetConfig,
    flatStatusOrder: ReturnType<typeof flattenStages>,
    groupedData: Map<string, IssueChartData[]>,
    issues: Issue[],
    activitiesMap: Map<string, IssueActivityItem[]>,
    activeStageId: string,
    generation: number
  ) => {
    const otherStages = cfg.statusStages.filter(s => s.statuses.length > 0 && s.id !== activeStageId);
    for (const stage of otherStages) {
      // A newer fetchData call (config change, refresh) superseded this
      // pass — stop rather than racing it and writing stale results.
      if (dataGenerationRef.current !== generation) return;
      try {
        const result = await fetchGroupPercentiles(host, {
          primarySearch: cfg.primarySearch,
          additionalSearch: cfg.additionalSearch ?? '',
          groupByField: cfg.groupByField ?? '',
          flatStatusOrder,
          stage,
          groupValues: Array.from(groupedData.keys()),
          alreadyLoaded: { issues, activitiesMap },
        });
        if (dataGenerationRef.current !== generation) return;
        percentileCacheRef.current.set(stage.id, result);
        setPercentileCache(new Map(percentileCacheRef.current));
        // The user switched to exactly this stage while we were computing
        // it in the background — reflect it right away instead of making
        // them wait for another click.
        if (selectedStageIdRef.current === stage.id) {
          setPercentilesByGroup(result);
        }
      } catch (e) {
        console.warn('[progress-tracking] Background percentile precompute failed for stage', stage.id, e);
      }
    }
  }, [host]);

  // ─── Data fetching ─────────────────────────────────────────────────────────
  const fetchData = useCallback(async (cfg: WidgetConfig, silent: boolean) => {
    const generation = ++dataGenerationRef.current;
    percentileCacheRef.current = new Map();
    setPercentileCache(new Map());

    if (!silent) {
      setIsLoading(true);
      setError(null);
    } else {
      setIsRefreshing(true);
    }

    try {
      await host.clearError();

      const combinedQuery = buildCombinedQuery(cfg.primarySearch, cfg.additionalSearch ?? '');

      // Load total count for title
      const count = await loadIssuesCount(host, combinedQuery);
      setTotalCount(count);

      // Update widget title
      const title = cfg.title || 'Progress Tracking';
      // YouTrack returns -1 when count is still calculating
      const countLabel = count >= 0 ? ` (${count})` : '';
      await host.setTitle(`${title}${countLabel}`, '');

      // Load issues + activities with progress updates
      const { issues, activitiesMap } = await loadIssuesWithActivities(
        host,
        combinedQuery,
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

      const flatStatusOrder = flattenStages(cfg.statusStages);

      // Build flat chart data (all issues matching the combined filter,
      // including open ones — no resolved filtering here, per spec section 4)
      const flatChartData = buildChartData(
        issues,
        activitiesMap,
        flatStatusOrder,
        cfg.showProjectedLT ?? false,
        cfg.groupByField ?? ''
      );

      // Group by groupByField value, sorted within each group by sortBy
      const groupedData = groupChartData(flatChartData, cfg.sortBy);

      // Active stage for percentile background zones — the live toolbar
      // selection if the user has changed it, otherwise the configured
      // default (percentileStageId). See section 11.4.
      const activeStageId = selectedStageIdRef.current || cfg.percentileStageId;
      const activeStage = cfg.statusStages.find(s => s.id === activeStageId) ?? null;

      let percentiles: Map<string, { p50: number; p80: number } | null>;
      if (activeStage === null) {
        // No stage configured/selected (or the selected id no longer exists
        // in cfg.statusStages) — no background zones for any group.
        percentiles = new Map();
      } else {
        if (!silent) {
          setLoadingMessage('Calculating percentiles...');
        }

        // Per-group lead-time percentiles (resolved-only sample) for the
        // background zones
        percentiles = await fetchGroupPercentiles(host, {
          primarySearch: cfg.primarySearch,
          additionalSearch: cfg.additionalSearch ?? '',
          groupByField: cfg.groupByField ?? '',
          flatStatusOrder,
          stage: activeStage,
          groupValues: Array.from(groupedData.keys()),
          alreadyLoaded: { issues, activitiesMap },
        });
        percentileCacheRef.current.set(activeStage.id, percentiles);
        setPercentileCache(new Map(percentileCacheRef.current));
      }

      setChartData(flatChartData);
      setGroups(groupedData);
      setPercentilesByGroup(percentiles);
      // Persist raw data for debug mode
      setDebugIssues(issues);
      setDebugActivitiesMap(activitiesMap);
      setError(null);

      // Selected stage is shown immediately (above); every other non-empty
      // stage is precomputed in the background so switching later is
      // instant. Not awaited — must not block isLoading from clearing.
      if (activeStage !== null) {
        void precomputeOtherStages(cfg, flatStatusOrder, groupedData, issues, activitiesMap, activeStage.id, generation);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      await host.setError(e as Error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [host, precomputeOtherStages]);

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
        // Parse whatever is stored so Configuration gets pre-filled fields
        // (e.g. description) even when primarySearch is not yet set.
        const parsedConfig = stored ? parseStoredConfig(stored) : null;
        setConfig(parsedConfig);
        configRef.current = parsedConfig;
        setSelectedStageId(parsedConfig?.percentileStageId ?? '');

        if (!stored?.primarySearch) {
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
    setSelectedStageId(newConfig.percentileStageId ?? '');
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

  // ─── Live stage switcher (toolbar) ─────────────────────────────────────────
  // Reads from the per-stage cache populated by fetchData/precomputeOtherStages
  // whenever possible — instant, no network. Only falls back to an on-demand
  // fetch (reusing already-loaded issues/activities, no re-fetch of issues)
  // when the background precompute for that stage hasn't landed yet — e.g.
  // the user clicks through several stages faster than the background pass
  // can keep up, or additionalSearch makes each stage's fetch slow. Not
  // persisted to config — see docs/PROGRESS_TRACKING_SPEC.md section 11.4.
  const handleStageChange = async (stageId: string) => {
    setSelectedStageId(stageId);
    if (!config) return;
    const stage = config.statusStages.find(s => s.id === stageId) ?? null;
    if (!stage) {
      setPercentilesByGroup(new Map());
      return;
    }
    const cached = percentileCacheRef.current.get(stageId);
    if (cached) {
      setPercentilesByGroup(cached);
      return;
    }
    if (debugIssues.length === 0) {
      // Data not loaded yet — fetchData will pick up the selection via the ref.
      return;
    }
    setIsRecomputingPercentiles(true);
    try {
      const flatStatusOrder = flattenStages(config.statusStages);
      const percentiles = await fetchGroupPercentiles(host, {
        primarySearch: config.primarySearch,
        additionalSearch: config.additionalSearch ?? '',
        groupByField: config.groupByField ?? '',
        flatStatusOrder,
        stage,
        groupValues: Array.from(groups.keys()),
        alreadyLoaded: { issues: debugIssues, activitiesMap: debugActivitiesMap },
      });
      setPercentilesByGroup(percentiles);
      percentileCacheRef.current.set(stageId, percentiles);
      setPercentileCache(new Map(percentileCacheRef.current));
    } catch (e) {
      console.warn('[progress-tracking] Failed to recompute percentiles for stage', stageId, e);
    } finally {
      setIsRecomputingPercentiles(false);
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
            {config?.primarySearch
              ? `No issues match the query: "${config.primarySearch}"`
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
        {isRecomputingPercentiles && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 'var(--ring-font-size-smaller)',
            color: 'var(--ring-secondary-color)',
          }}>
            <LoaderInline />
          </div>
        )}
        {(() => {
          const stageItems: SelectItem[] = (config?.statusStages ?? [])
            .filter(s => s.statuses.length > 0)
            .map(s => ({ key: s.id, label: s.name }));
          if (stageItems.length === 0) return null;
          return (
            <Select
              data={stageItems}
              selected={stageItems.find(i => i.key === selectedStageId) ?? null}
              label="Перцентили до этапа"
              onChange={(item: SelectItem | null) => item && handleStageChange(String(item.key))}
            />
          );
        })()}
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

      {/* Grouped Gantt charts — scrollable, takes all remaining space */}
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <GroupedGanttChart
          groups={groups}
          percentilesByGroup={percentilesByGroup}
          statusOrder={flattenStages(config?.statusStages ?? [])}
          showProjectedLT={config?.showProjectedLT ?? false}
          gridStep={config?.gridStep ?? 1}
          baseUrl={baseUrl}
          groupFieldLabel={config?.groupByField || undefined}
          percentileStageName={config?.statusStages.find(s => s.id === selectedStageId)?.name}
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
          {(() => {
            const debugFlatStatusOrder = flattenStages(config?.statusStages ?? []);
            return chartData.map((issue) => {
              const issueObj = debugIssues.find((i) => i.id === issue.issueId);
              const activities = debugActivitiesMap.get(issue.issueId) ?? [];
              const issueCreatedAt = issueObj?.created ?? Date.now();
              const timeline = parseStateTimeline(activities, issueCreatedAt);
              const leadTimeStartAt = findLeadTimeStartAt(activities, debugFlatStatusOrder, issueCreatedAt);
              const startStatusName = debugFlatStatusOrder[0]?.name ?? '(none configured)';
              return (
              <div key={issue.issueId} className="ip-debug__issue">
                <div className="ip-debug__issue-title">
                  <strong>{issue.idReadable}</strong>
                  {': '}
                  {issue.summary}
                </div>
                <div className="ip-debug__no-history">
                  Start status: <code>{startStatusName}</code>
                  {' | '}
                  Created: <code>{new Date(issueCreatedAt).toISOString()}</code>
                  {' | '}
                  leadTimeStartAt: <code>{new Date(leadTimeStartAt).toISOString()}</code>
                  {leadTimeStartAt === issueCreatedAt && ' (fell back to creation — start status not found in timeline)'}
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
            });
          })()}
        </div>
      )}
    </div>
  );
}
