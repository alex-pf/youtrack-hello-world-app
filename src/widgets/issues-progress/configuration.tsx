import React, {memo, useCallback, useEffect, useRef, useState} from 'react';
import {Size as InputSize} from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Select, {type SelectItem} from '@jetbrains/ring-ui-built/components/select/select';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import QueryAssist from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import type {QueryAssistRequestParams} from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, StatusOrderItem, LtSettings, ProjectInfo, IssueType} from './types';
import {serializeConfig} from './types';
import {loadProjects, loadProjectStates, loadIssueTypes, queryAssistDataSource} from './resources';

interface Props {
  config: WidgetConfig | null;
  host: EmbeddableWidgetAPI;
  onSave: (config: WidgetConfig) => void;
  onCancel: () => void;
}

const REFRESH_OPTIONS: SelectItem[] = [
  {key: 0, label: 'No auto-refresh'},
  {key: 15, label: '15 min'},
  {key: 30, label: '30 min'},
  {key: 60, label: '1 hour'},
  {key: 120, label: '2 hours'},
];

const ConfigurationComponent: React.FC<Props> = ({config, host, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(config?.projects ?? []);
  const [availableProjects, setAvailableProjects] = useState<ProjectInfo[]>([]);
  const [availableStates, setAvailableStates] = useState<StatusOrderItem[]>([]);
  const [statusOrder, setStatusOrder] = useState<StatusOrderItem[]>(config?.statusOrder ?? []);
  const [ltEnabled, setLtEnabled] = useState(config?.ltEnabled ?? false);
  const [ltSettings, setLtSettings] = useState<LtSettings>(config?.ltSettings ?? {});
  const [availableIssueTypes, setAvailableIssueTypes] = useState<IssueType[]>([]);
  const [showEstimateDate, setShowEstimateDate] = useState(config?.showEstimateDate ?? false);
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshInterval ?? 0);
  const [debugMode, setDebugMode] = useState(config?.debugMode ?? false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingStates, setIsLoadingStates] = useState(false);

  // Skip the selectedProjectIds effect on the very first render to avoid
  // double-loading when editing an existing config (mount effect handles that).
  const isFirstRender = useRef(true);

  // On mount: load projects list; if editing existing config, also load states/types
  useEffect(() => {
    setIsLoadingProjects(true);
    loadProjects(host)
      .then(setAvailableProjects)
      .finally(() => setIsLoadingProjects(false));

    if (config?.projects?.length) {
      setIsLoadingStates(true);
      Promise.all([
        loadProjectStates(host, config.projects),
        loadIssueTypes(host, config.projects),
      ])
        .then(([states, types]) => {
          setAvailableStates(states);
          setAvailableIssueTypes(types);
        })
        .finally(() => setIsLoadingStates(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When selected projects change, reload states and issue types
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (selectedProjectIds.length === 0) {
      setAvailableStates([]);
      setAvailableIssueTypes([]);
      return;
    }
    setIsLoadingStates(true);
    Promise.all([
      loadProjectStates(host, selectedProjectIds),
      loadIssueTypes(host, selectedProjectIds),
    ])
      .then(([states, types]) => {
        setAvailableStates(states);
        setAvailableIssueTypes(types);
        // Remove any statusOrder items that are no longer available
        setStatusOrder(prev => prev.filter(s => states.some(st => st.id === s.id)));
      })
      .finally(() => setIsLoadingStates(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectIds]);

  // QueryAssist data source
  const queryAssistHandler = useCallback(
    async (params: QueryAssistRequestParams) => {
      try {
        return await queryAssistDataSource(host, {
          query: params.query,
          caret: params.caret,
        });
      } catch {
        return {query: params.query, caret: params.caret, suggestions: []};
      }
    },
    [host]
  );

  // ── Status sorter helpers ──────────────────────────────────────────────────

  const toggleStatus = (status: StatusOrderItem) => {
    setStatusOrder(prev => {
      const exists = prev.find(s => s.id === status.id);
      if (exists) return prev.filter(s => s.id !== status.id);
      return [...prev, status];
    });
  };

  const moveStatusUp = (index: number) => {
    if (index === 0) return;
    setStatusOrder(prev => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveStatusDown = (index: number) => {
    setStatusOrder(prev => {
      if (index === prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  // ── Project Select helpers ─────────────────────────────────────────────────

  const projectSelectItems: SelectItem[] = availableProjects.map(p => ({
    key: p.id,
    label: p.name,
  }));

  const selectedProjectItems: SelectItem[] = selectedProjectIds.map(id => {
    const p = availableProjects.find(proj => proj.id === id);
    return p ? {key: p.id, label: p.name} : {key: id, label: id};
  });

  const handleProjectsChange = (items: SelectItem[]) => {
    setSelectedProjectIds(items.map(i => String(i.key)));
  };

  // ── LT settings helpers ────────────────────────────────────────────────────

  const handleLtChange = (typeName: string, field: 'lt50' | 'lt80', value: string) => {
    const num = value === '' ? undefined : Math.max(0, Number(value));
    setLtSettings(prev => ({
      ...prev,
      [typeName]: {
        ...prev[typeName],
        [field]: num,
      },
    }));
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const newConfig: WidgetConfig = {
      search,
      projects: selectedProjectIds,
      statusOrder,
      ltEnabled,
      ltSettings,
      showEstimateDate,
      refreshInterval,
      debugMode,
    };
    await host.storeConfig(serializeConfig(newConfig));
    onSave(newConfig);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <form className="ring-form" style={{padding: '8px 16px', overflowY: 'auto', maxHeight: '100vh'}}>
      <span className="ring-form__title">Issues Progress Settings</span>

      {/* ── 1. Query Filter ── */}
      <div style={{marginTop: 8, marginBottom: 4}}>
        <span className="ip-section-label">Query Filter</span>
        <QueryAssist
          query={search}
          placeholder="project: DEMO State: Open"
          dataSource={queryAssistHandler}
          onChange={({query}) => setSearch(query)}
          onApply={({query}) => setSearch(query)}
          size={InputSize.M}
        />
      </div>

      {/* ── 2. Project Selector ── */}
      <div style={{marginTop: 12, marginBottom: 8}}>
        <span className="ip-section-label">Projects</span>
        {isLoadingProjects && availableProjects.length === 0 ? (
          <LoaderInline />
        ) : (
          <Select
            multiple
            filter
            tags={{}}
            label="Select projects"
            size={InputSize.FULL}
            data={projectSelectItems}
            selected={selectedProjectItems}
            onChange={handleProjectsChange}
            loading={isLoadingProjects}
            notFoundMessage="No projects found"
          />
        )}
      </div>

      {/* ── 3. Status Sorter (only when projects selected) ── */}
      {selectedProjectIds.length > 0 && (
        <div style={{marginTop: 12, marginBottom: 8}}>
          <span className="ip-section-label">Status Order</span>
          {isLoadingStates ? (
            <LoaderInline />
          ) : (
            <div className="ip-status-sorter">
              {/* Checkboxes for available statuses */}
              <div className="ip-status-sorter__available">
                {availableStates.map(status => {
                  const isChecked = statusOrder.some(s => s.id === status.id);
                  return (
                    <label
                      key={status.id}
                      style={{display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer'}}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleStatus(status)}
                      />
                      {status.color && (
                        <span
                          className="ip-status-sorter__color-dot"
                          style={{backgroundColor: status.color}}
                        />
                      )}
                      <span
                        style={{
                          fontSize: 'var(--ring-font-size)',
                          color: 'var(--ring-text-color)',
                        }}
                      >
                        {status.name}
                      </span>
                    </label>
                  );
                })}
              </div>

              {/* Ordered list with up/down arrows */}
              {statusOrder.length > 0 && (
                <div className="ip-status-sorter__ordered">
                  {statusOrder.map((status, idx) => (
                    <div key={status.id} className="ip-status-sorter__item">
                      {status.color && (
                        <span
                          className="ip-status-sorter__color-dot"
                          style={{backgroundColor: status.color}}
                        />
                      )}
                      <span className="ip-status-sorter__item-name">{status.name}</span>
                      <button
                        type="button"
                        onClick={() => moveStatusUp(idx)}
                        disabled={idx === 0}
                        title="Move up"
                        aria-label={`Move ${status.name} up`}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: idx === 0 ? 'default' : 'pointer',
                          padding: '0 4px',
                          opacity: idx === 0 ? 0.3 : 1,
                          color: 'var(--ring-text-color)',
                          fontSize: 14,
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStatusDown(idx)}
                        disabled={idx === statusOrder.length - 1}
                        title="Move down"
                        aria-label={`Move ${status.name} down`}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: idx === statusOrder.length - 1 ? 'default' : 'pointer',
                          padding: '0 4px',
                          opacity: idx === statusOrder.length - 1 ? 0.3 : 1,
                          color: 'var(--ring-text-color)',
                          fontSize: 14,
                        }}
                      >
                        ↓
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 4. Lead Time Settings ── */}
      <div style={{marginTop: 12, marginBottom: 8}}>
        <Checkbox
          label="Enable Lead Time thresholds"
          checked={ltEnabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLtEnabled(e.target.checked)}
        />
        {ltEnabled && (
          <div className="ip-lt-settings">
            {selectedProjectIds.length === 0 ? (
              <p className="ip-note">Select projects first to load issue types</p>
            ) : isLoadingStates ? (
              <LoaderInline />
            ) : availableIssueTypes.length === 0 ? (
              <p className="ip-note ip-note--warning">
                No issue types found in the selected project(s).
                The widget looks for a custom field named <strong>&ldquo;Type&rdquo;</strong> with
                enum values. Make sure such a field exists and is attached to the project.
              </p>
            ) : (
              availableIssueTypes.map(type => (
                <div key={type.id} className="ip-lt-settings__row">
                  <span className="ip-lt-settings__type-name">{type.name}</span>
                  <input
                    type="number"
                    min={0}
                    value={ltSettings[type.name]?.lt50 ?? ''}
                    onChange={e => handleLtChange(type.name, 'lt50', e.target.value)}
                    placeholder="LT 50% (days)"
                    aria-label={`LT 50% for ${type.name} in days`}
                    className="ip-lt-settings__input"
                  />
                  <input
                    type="number"
                    min={0}
                    value={ltSettings[type.name]?.lt80 ?? ''}
                    onChange={e => handleLtChange(type.name, 'lt80', e.target.value)}
                    placeholder="LT 80% (days)"
                    aria-label={`LT 80% for ${type.name} in days`}
                    className="ip-lt-settings__input"
                  />
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── 5. Estimate Date Toggle ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <Checkbox
          label="Show Estimate Date history"
          checked={showEstimateDate}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setShowEstimateDate(e.target.checked)}
        />
      </div>

      {/* ── 5b. Debug Mode Toggle ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <Checkbox
          label="Отладка (показать историю переходов статусов)"
          checked={debugMode}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDebugMode(e.target.checked)}
        />
      </div>

      {/* ── 6. Refresh Rate ── */}
      <div style={{marginTop: 12, marginBottom: 16}}>
        <span className="ip-section-label">Auto-refresh</span>
        <Select
          label="Refresh rate"
          size={InputSize.FULL}
          data={REFRESH_OPTIONS}
          selected={REFRESH_OPTIONS.find(o => o.key === refreshInterval)}
          onChange={(item: SelectItem | null) =>
            setRefreshInterval((item?.key as number) ?? 0)
          }
        />
      </div>

      <ButtonSet>
        <Button primary disabled={!search.trim()} onClick={handleSave}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </ButtonSet>
    </form>
  );
};

export default memo(ConfigurationComponent);