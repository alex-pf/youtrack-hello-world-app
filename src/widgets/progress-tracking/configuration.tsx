import React, {memo, useCallback, useEffect, useRef, useState} from 'react';

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; });
  return ref.current;
}
import Input, {Size as InputSize} from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Select, {type SelectItem} from '@jetbrains/ring-ui-built/components/select/select';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import QueryAssist from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import type {QueryAssistRequestParams} from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, StatusOrderItem, StatusStage, ProjectInfo, GroupableField, GridStep, SortBy} from './types';
import {serializeConfig} from './types';
import {loadProjects, loadProjectCustomFields, queryAssistDataSource} from './resources';

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

const SORT_OPTIONS: SelectItem[] = [
  {key: 'startDate', label: 'Дата старта'},
  {key: 'issueNumber', label: 'По номеру'},
  {key: 'estimatedDate', label: 'Estimated Date'},
];

const GRID_STEP_OPTIONS: SelectItem[] = [
  {key: 1, label: '1 день'},
  {key: 7, label: 'Неделя (7 дней)'},
  {key: 14, label: '2 недели (14 дней)'},
  {key: 28, label: '4 недели (28 дней)'},
];

const ConfigurationComponent: React.FC<Props> = ({config, host, onSave, onCancel}) => {
  const [title, setTitle] = useState(config?.title ?? '');
  const [primarySearch, setPrimarySearch] = useState(config?.primarySearch ?? '');
  const [additionalSearch, setAdditionalSearch] = useState(config?.additionalSearch ?? '');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(config?.projects ?? []);
  const [availableProjects, setAvailableProjects] = useState<ProjectInfo[]>([]);
  const [availableStates, setAvailableStates] = useState<StatusOrderItem[]>([]);
  const [statusStages, setStatusStages] = useState<StatusStage[]>(config?.statusStages ?? []);
  const [percentileStageId, setPercentileStageId] = useState<string>(config?.percentileStageId ?? '');
  const [availableGroupableFields, setAvailableGroupableFields] = useState<GroupableField[]>([]);
  const [groupByField, setGroupByField] = useState<string>(config?.groupByField ?? '');
  const [showProjectedLT, setShowProjectedLT] = useState(config?.showProjectedLT ?? false);
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshInterval ?? 0);
  const [sortBy, setSortBy] = useState<SortBy>(config?.sortBy ?? 'startDate');
  const [gridStep, setGridStep] = useState<GridStep>(config?.gridStep ?? 1);
  const [debugMode, setDebugMode] = useState(config?.debugMode ?? false);
  const [description, setDescription] = useState(config?.description ?? '');
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingStates, setIsLoadingStates] = useState(false);

  // Whether groupByField was already present in the config we were opened
  // with — used to decide if we're allowed to auto-pick a default (only for
  // a brand-new widget with no saved groupByField, per spec section 3).
  const hadInitialGroupByField = useRef(Boolean(config?.groupByField));

  const prevProjectIds = usePrevious(selectedProjectIds);

  // On mount: load projects list; if editing existing config, also load states/groupable fields
  useEffect(() => {
    setIsLoadingProjects(true);
    loadProjects(host)
      .then(setAvailableProjects)
      .finally(() => setIsLoadingProjects(false));

    if (config?.projects?.length) {
      setIsLoadingStates(true);
      loadProjectCustomFields(host, config.projects)
        .then(({states, groupableFields}) => {
          setAvailableStates(states);
          setAvailableGroupableFields(groupableFields);
          applyDefaultGroupByField(groupableFields);
        })
        .finally(() => setIsLoadingStates(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When selected projects change, reload states and groupable fields
  useEffect(() => {
    if (prevProjectIds === selectedProjectIds) return;
    if (selectedProjectIds.length === 0) {
      setAvailableStates([]);
      setAvailableGroupableFields([]);
      return;
    }
    setIsLoadingStates(true);
    loadProjectCustomFields(host, selectedProjectIds)
      .then(({states, groupableFields}) => {
        setAvailableStates(states);
        setAvailableGroupableFields(groupableFields);
        // Remove any status items that are no longer available from every stage
        setStatusStages(prev =>
          prev.map(stage => ({
            ...stage,
            statuses: stage.statuses.filter(s => states.some(st => st.id === s.id)),
          }))
        );
        applyDefaultGroupByField(groupableFields);
      })
      .finally(() => setIsLoadingStates(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, selectedProjectIds, prevProjectIds]);

  // Auto-pick a default groupByField the first time groupable fields load,
  // but only for a brand-new widget (no saved groupByField at open time) and
  // only if the user hasn't already picked one in this session. Prefers a
  // field named/localized "type"; else falls back to the first available field.
  const applyDefaultGroupByField = (fields: GroupableField[]) => {
    if (hadInitialGroupByField.current) return;
    setGroupByField(prev => {
      if (prev) return prev;
      if (fields.length === 0) return prev;
      const typeField = fields.find(
        f =>
          f.name?.toLowerCase() === 'type' ||
          f.localizedName?.toLowerCase() === 'type'
      );
      return (typeField ?? fields[0]).name;
    });
  };

  // QueryAssist data source (shared by both filter fields)
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

  // ── Stage editor helpers ────────────────────────────────────────────────────

  const assignedStatusIds = new Set(statusStages.flatMap(s => s.statuses.map(st => st.id)));
  const unassignedStates = availableStates.filter(s => !assignedStatusIds.has(s.id));

  const genStageId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `stage-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const addStage = () => {
    setStatusStages(prev => [
      ...prev,
      {id: genStageId(), name: `Этап ${prev.length + 1}`, statuses: []},
    ]);
  };

  const removeStage = (stageId: string) => {
    setStatusStages(prev => prev.filter(s => s.id !== stageId));
  };

  const renameStage = (stageId: string, name: string) => {
    setStatusStages(prev => prev.map(s => (s.id === stageId ? {...s, name} : s)));
  };

  const moveStageUp = (index: number) => {
    if (index === 0) return;
    setStatusStages(prev => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveStageDown = (index: number) => {
    setStatusStages(prev => {
      if (index === prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const addStatusToStage = (stageId: string, status: StatusOrderItem) => {
    setStatusStages(prev =>
      prev.map(s => (s.id === stageId ? {...s, statuses: [...s.statuses, status]} : s))
    );
  };

  const removeStatusFromStage = (stageId: string, statusId: string) => {
    setStatusStages(prev =>
      prev.map(s =>
        s.id === stageId ? {...s, statuses: s.statuses.filter(st => st.id !== statusId)} : s
      )
    );
  };

  const moveStatusUpInStage = (stageId: string, index: number) => {
    if (index === 0) return;
    setStatusStages(prev =>
      prev.map(s => {
        if (s.id !== stageId) return s;
        const next = [...s.statuses];
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
        return {...s, statuses: next};
      })
    );
  };

  const moveStatusDownInStage = (stageId: string, index: number) => {
    setStatusStages(prev =>
      prev.map(s => {
        if (s.id !== stageId || index === s.statuses.length - 1) return s;
        const next = [...s.statuses];
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
        return {...s, statuses: next};
      })
    );
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

  // ── Group By Select helpers ────────────────────────────────────────────────

  const groupBySelectItems: SelectItem[] = availableGroupableFields.map(f => ({
    key: f.name,
    label: f.localizedName || f.name,
  }));

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const newConfig: WidgetConfig = {
      title: title.trim() || undefined,
      projects: selectedProjectIds,
      primarySearch,
      additionalSearch,
      groupByField,
      statusStages,
      percentileStageId,
      showProjectedLT,
      gridStep,
      sortBy,
      refreshInterval,
      debugMode,
      description,
    };
    await host.storeConfig(serializeConfig(newConfig));
    onSave(newConfig);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <form className="ring-form ip-config-form">
      <span className="ring-form__title">Progress Tracking Settings</span>

      {/* ── Title ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <Input
          label="Заголовок (опционально)"
          size={InputSize.FULL}
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
      </div>

      {/* ── 1. Project Selector ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
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

      {/* ── 2. Primary Filter ── */}
      <div style={{marginTop: 8, marginBottom: 4}}>
        <span className="ip-section-label">Основной фильтр</span>
        <QueryAssist
          query={primarySearch}
          placeholder="project: DEMO State: Open"
          dataSource={queryAssistHandler}
          onChange={({query}) => setPrimarySearch(query)}
          onApply={({query}) => setPrimarySearch(query)}
          size={InputSize.M}
        />
      </div>

      {/* ── 3. Additional Filter ── */}
      <div style={{marginTop: 8, marginBottom: 4}}>
        <span className="ip-section-label">Дополнительный фильтр (опционально)</span>
        <QueryAssist
          query={additionalSearch}
          placeholder="priority: Critical"
          dataSource={queryAssistHandler}
          onChange={({query}) => setAdditionalSearch(query)}
          onApply={({query}) => setAdditionalSearch(query)}
          size={InputSize.M}
        />
      </div>

      {/* ── 4. Group By (only when projects selected) ── */}
      {selectedProjectIds.length > 0 && (
        <div style={{marginTop: 12, marginBottom: 8}}>
          <span className="ip-section-label">Группировать по</span>
          {isLoadingStates ? (
            <LoaderInline />
          ) : availableGroupableFields.length === 0 ? (
            <p className="ip-note ip-note--warning">
              В выбранных проектах не найдено полей-справочников (enum) для группировки.
              Убедитесь, что у проекта есть настроенное enum-поле (например,{' '}
              <strong>&ldquo;Type&rdquo;</strong>) с непустым набором значений.
            </p>
          ) : (
            <Select
              filter
              label="Выберите поле"
              size={InputSize.FULL}
              data={groupBySelectItems}
              selected={groupBySelectItems.find(o => o.key === groupByField) ?? null}
              onChange={(item: SelectItem | null) => setGroupByField(item ? String(item.key) : '')}
              notFoundMessage="No fields found"
            />
          )}
        </div>
      )}

      {/* ── 5. Status Stages (only when projects selected) ── */}
      {selectedProjectIds.length > 0 && (
        <div style={{marginTop: 12, marginBottom: 8}}>
          <span className="ip-section-label">Этапы (Status Order)</span>
          {isLoadingStates ? (
            <LoaderInline />
          ) : (
            <div className="ip-status-sorter">
              {statusStages.map((stage, stageIdx) => {
                const stageUnassignedItems: SelectItem[] = unassignedStates.map(s => ({
                  key: s.id,
                  label: s.name,
                }));
                return (
                  <div key={stage.id} className="ip-stage-block">
                    <div className="ip-status-sorter__item" style={{border: 'none', padding: 0, marginBottom: 8}}>
                      <Input
                        size={InputSize.FULL}
                        value={stage.name}
                        onChange={e => renameStage(stage.id, e.target.value)}
                      />
                      <button
                        type="button"
                        className="ip-status-sorter__btn"
                        onClick={() => moveStageUp(stageIdx)}
                        disabled={stageIdx === 0}
                        title="Move stage up"
                        aria-label={`Move stage ${stage.name} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ip-status-sorter__btn"
                        onClick={() => moveStageDown(stageIdx)}
                        disabled={stageIdx === statusStages.length - 1}
                        title="Move stage down"
                        aria-label={`Move stage ${stage.name} down`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="ip-status-sorter__btn"
                        onClick={() => removeStage(stage.id)}
                        title="Remove stage"
                        aria-label={`Remove stage ${stage.name}`}
                      >
                        ✕
                      </button>
                    </div>

                    {stage.statuses.length > 0 && (
                      <div className="ip-status-sorter__ordered">
                        {stage.statuses.map((status, idx) => (
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
                              className="ip-status-sorter__btn"
                              onClick={() => moveStatusUpInStage(stage.id, idx)}
                              disabled={idx === 0}
                              title="Move up"
                              aria-label={`Move ${status.name} up`}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="ip-status-sorter__btn"
                              onClick={() => moveStatusDownInStage(stage.id, idx)}
                              disabled={idx === stage.statuses.length - 1}
                              title="Move down"
                              aria-label={`Move ${status.name} down`}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="ip-status-sorter__btn"
                              onClick={() => removeStatusFromStage(stage.id, status.id)}
                              title="Remove from stage"
                              aria-label={`Remove ${status.name} from stage`}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {unassignedStates.length > 0 && (
                      <div style={{marginTop: 8}}>
                        <Select
                          filter
                          label="+ Добавить статус в этап"
                          size={InputSize.FULL}
                          data={stageUnassignedItems}
                          selected={null}
                          onChange={(item: SelectItem | null) => {
                            if (!item) return;
                            const status = unassignedStates.find(s => s.id === item.key);
                            if (status) addStatusToStage(stage.id, status);
                          }}
                          notFoundMessage="Нет доступных статусов"
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              <Button onClick={addStage}>+ Добавить этап</Button>
            </div>
          )}

          {/* ── Percentile default stage ── */}
          <div style={{marginTop: 12, marginBottom: 8}}>
            <span className="ip-section-label">Перцентили по умолчанию</span>
            <Select
              filter
              label="Выберите этап"
              size={InputSize.FULL}
              data={statusStages
                .filter(s => s.statuses.length > 0)
                .map(s => ({key: s.id, label: s.name}))}
              selected={
                statusStages
                  .filter(s => s.statuses.length > 0)
                  .map(s => ({key: s.id, label: s.name}))
                  .find(o => o.key === percentileStageId) ?? null
              }
              onChange={(item: SelectItem | null) => setPercentileStageId(item ? String(item.key) : '')}
              notFoundMessage="Нет доступных этапов"
            />
          </div>
        </div>
      )}

      {/* ── 6. Projected Lead Time Toggle ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <Checkbox
          label="Show Projected Lead Time"
          checked={showProjectedLT}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setShowProjectedLT(e.target.checked)}
        />
      </div>

      {/* ── 7. Debug Mode Toggle ── */}
      <div style={{marginTop: 8, marginBottom: 8}}>
        <Checkbox
          label="Debug (show status transition history)"
          checked={debugMode}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDebugMode(e.target.checked)}
        />
      </div>

      {/* ── 8. Grid Step ── */}
      <div style={{marginTop: 12, marginBottom: 16}}>
        <span className="ip-section-label">Шаг сетки</span>
        <Select
          label="Шаг сетки"
          size={InputSize.FULL}
          data={GRID_STEP_OPTIONS}
          selected={GRID_STEP_OPTIONS.find(o => o.key === gridStep)}
          onChange={(item: SelectItem | null) => setGridStep((item?.key as GridStep) ?? 1)}
        />
      </div>

      {/* ── 9. Sort ── */}
      <div style={{marginTop: 12, marginBottom: 16}}>
        <span className="ip-section-label">Сортировка</span>
        <Select
          label="Сортировка"
          size={InputSize.FULL}
          data={SORT_OPTIONS}
          selected={SORT_OPTIONS.find(o => o.key === sortBy)}
          onChange={(item: SelectItem | null) => setSortBy((item?.key as SortBy) ?? 'startDate')}
        />
      </div>

      {/* ── 10. Refresh Rate ── */}
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

      {/* ── 11. Description (Markdown) ── */}
      <div style={{marginTop: 12, marginBottom: 8}}>
        <span className="ip-section-label">Description (Markdown)</span>
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
        <Button primary disabled={!primarySearch.trim()} onClick={handleSave}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </ButtonSet>
    </form>
  );
};

export default memo(ConfigurationComponent);
