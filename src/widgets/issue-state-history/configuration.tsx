import React, {memo, useCallback, useEffect, useRef, useState} from 'react';

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; });
  return ref.current;
}
import {Size as InputSize} from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Select, {type SelectItem} from '@jetbrains/ring-ui-built/components/select/select';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import QueryAssist from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import type {QueryAssistRequestParams} from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, StatusOrderItem, ProjectInfo, GridStep} from './types';
import {serializeConfig} from './types';
import {loadProjects, loadProjectStates, queryAssistDataSource} from './resources';

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

const GRID_STEP_OPTIONS: SelectItem[] = [
  {key: 'day', label: 'День'},
  {key: 'week', label: 'Неделя'},
  {key: 'month', label: 'Месяц'},
];

const ConfigurationComponent: React.FC<Props> = ({config, host, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(config?.projects ?? []);
  const [availableProjects, setAvailableProjects] = useState<ProjectInfo[]>([]);
  const [availableStates, setAvailableStates] = useState<StatusOrderItem[]>([]);
  const [statusOrder, setStatusOrder] = useState<StatusOrderItem[]>(config?.statusOrder ?? []);
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshInterval ?? 0);
  const [debugMode, setDebugMode] = useState(config?.debugMode ?? false);
  const [description, setDescription] = useState(config?.description ?? '');
  const [gridStep, setGridStep] = useState<GridStep>(config?.gridStep ?? 'day');
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingStates, setIsLoadingStates] = useState(false);

  const prevProjectIds = usePrevious(selectedProjectIds);

  // On mount: load projects list; if editing existing config, also load states
  useEffect(() => {
    setIsLoadingProjects(true);
    loadProjects(host)
      .then(setAvailableProjects)
      .finally(() => setIsLoadingProjects(false));

    if (config?.projects?.length) {
      setIsLoadingStates(true);
      loadProjectStates(host, config.projects)
        .then(setAvailableStates)
        .finally(() => setIsLoadingStates(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When selected projects change, reload states
  useEffect(() => {
    if (prevProjectIds === selectedProjectIds) return;
    if (selectedProjectIds.length === 0) {
      setAvailableStates([]);
      return;
    }
    setIsLoadingStates(true);
    loadProjectStates(host, selectedProjectIds)
      .then(states => {
        setAvailableStates(states);
        // Remove any statusOrder items that are no longer available
        setStatusOrder(prev => prev.filter(s => states.some(st => st.id === s.id)));
      })
      .finally(() => setIsLoadingStates(false));
  }, [host, selectedProjectIds, prevProjectIds]);

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

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const newConfig: WidgetConfig = {
      search,
      projects: selectedProjectIds,
      statusOrder,
      refreshInterval,
      debugMode,
      description,
      gridStep,
    };
    await host.storeConfig(serializeConfig(newConfig));
    onSave(newConfig);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <form className="ring-form" style={{padding: '8px 16px', overflowY: 'auto', maxHeight: '100vh'}}>
      <span className="ring-form__title">Issue State History Settings</span>

      {/* ── 1. Project Selector ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <span className="ish-section-label">Projects</span>
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

      {/* ── 2. Query Filter ── */}
      <div style={{marginTop: 8, marginBottom: 4}}>
        <span className="ish-section-label">Query Filter</span>
        <QueryAssist
          query={search}
          placeholder="project: DEMO State: Open"
          dataSource={queryAssistHandler}
          onChange={({query}) => setSearch(query)}
          onApply={({query}) => setSearch(query)}
          size={InputSize.M}
        />
      </div>

      {/* ── 3. Status Sorter (only when projects selected) ── */}
      {selectedProjectIds.length > 0 && (
        <div style={{marginTop: 12, marginBottom: 8}}>
          <span className="ish-section-label">Status Order</span>
          <p className="ish-note">
            Первый статус в списке ниже — точка отсчёта начала полосы на графике
            (start status). Остальные статусы определяют дальнейший ход истории.
          </p>
          {isLoadingStates ? (
            <LoaderInline />
          ) : (
            <div className="ish-status-sorter">
              {/* Checkboxes for available statuses */}
              <div className="ish-status-sorter__available">
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
                          className="ish-status-sorter__color-dot"
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
                <div className="ish-status-sorter__ordered">
                  {statusOrder.map((status, idx) => (
                    <div key={status.id} className="ish-status-sorter__item">
                      {idx === 0 && (
                        <span className="ish-status-sorter__start-badge" title="Начало полосы">
                          START
                        </span>
                      )}
                      {status.color && (
                        <span
                          className="ish-status-sorter__color-dot"
                          style={{backgroundColor: status.color}}
                        />
                      )}
                      <span className="ish-status-sorter__item-name">{status.name}</span>
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

      {/* ── 4. Debug Mode Toggle ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <Checkbox
          label="Debug (show status transition history)"
          checked={debugMode}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDebugMode(e.target.checked)}
        />
      </div>

      {/* ── 5. Refresh Rate ── */}
      <div style={{marginTop: 12, marginBottom: 16}}>
        <span className="ish-section-label">Auto-refresh</span>
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

      {/* ── 6. Grid Step ── */}
      <div style={{marginTop: 12, marginBottom: 16}}>
        <span className="ish-section-label">Шаг сетки</span>
        <Select
          label="Grid step"
          size={InputSize.FULL}
          data={GRID_STEP_OPTIONS}
          selected={GRID_STEP_OPTIONS.find(o => o.key === gridStep)}
          onChange={(item: SelectItem | null) =>
            setGridStep((item?.key as GridStep) ?? 'day')
          }
        />
      </div>

      {/* ── Description (Markdown) ── */}
      <div style={{marginTop: 12, marginBottom: 8}}>
        <span className="ish-section-label">Description (Markdown)</span>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Напишите описание для пользователей виджета. Поддерживается **Markdown**."
          rows={5}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            fontFamily: 'var(--ring-font-family)',
            fontSize: 'var(--ring-font-size)',
            color: 'var(--ring-text-color)',
            background: 'var(--ring-content-background-color)',
            border: '1px solid var(--ring-borders-color)',
            borderRadius: 4,
            padding: '6px 8px',
            lineHeight: '1.5',
          }}
        />
      </div>

      <div style={{marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--ring-line-color)', color: 'var(--ring-secondary-color)', fontSize: '11px', lineHeight: '1.6'}}>
        <div>Version: <strong>{__APP_VERSION__}</strong></div>
        <div>Updated: {new Date(__BUILD_TIME__).toLocaleString()}</div>
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
