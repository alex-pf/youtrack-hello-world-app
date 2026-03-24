import React, {memo, useCallback, useEffect, useRef, useState} from 'react';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import {Size as InputSize} from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Select, {type SelectItem} from '@jetbrains/ring-ui-built/components/select/select';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import QueryAssist from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import type {QueryAssistRequestParams} from '@jetbrains/ring-ui-built/components/query-assist/query-assist';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, FieldColumnConfig} from './types';
import {loadFieldsForQuery, queryAssistDataSource} from './resources';

interface Props {
  config: WidgetConfig | null;
  host: EmbeddableWidgetAPI;
  onSave: (config: WidgetConfig) => void;
  onCancel: () => void;
}

interface FieldData {
  fieldConfig: FieldColumnConfig;
}

type FieldSelectItem = SelectItem<FieldData>;

function fieldToSelectItem(fc: FieldColumnConfig): FieldSelectItem {
  return {
    key: fc.key,
    label: fc.label,
    fieldConfig: fc,
  } as FieldSelectItem;
}

function selectItemToField(item: FieldSelectItem): FieldColumnConfig {
  const fc = (item as unknown as FieldData).fieldConfig;
  return fc ?? {key: String(item.key), label: item.label || String(item.key)};
}

const REFRESH_OPTIONS: SelectItem[] = [
  {key: 0, label: 'Выключено'},
  {key: 15, label: '15 минут'},
  {key: 30, label: '30 минут'},
  {key: 45, label: '45 минут'},
  {key: 60, label: '1 час'},
  {key: 90, label: '1.5 часа'},
  {key: 120, label: '2 часа'},
];

const ConfigurationComponent: React.FC<Props> = ({config, host, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [title, setTitle] = useState(config?.title ?? '');
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshInterval ?? 0);
  const [selectedFields, setSelectedFields] = useState<FieldColumnConfig[]>(
    config?.visibleFields ?? []
  );
  const [availableFieldItems, setAvailableFieldItems] = useState<FieldSelectItem[]>([]);
  const [isLoadingFields, setIsLoadingFields] = useState(false);

  // Drag state
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Debounce timer for loading fields after query changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Data source for QueryAssist
  const queryAssistHandler = useCallback(async (params: QueryAssistRequestParams) => {
    try {
      return await queryAssistDataSource(host, {
        query: params.query,
        caret: params.caret,
      });
    } catch {
      return {query: params.query, caret: params.caret, suggestions: []};
    }
  }, [host]);

  // Load fields for the current search query
  const refreshFields = useCallback(async (query: string) => {
    setIsLoadingFields(true);
    try {
      const fields = await loadFieldsForQuery(host, query);
      setAvailableFieldItems(fields.map(fieldToSelectItem));
    } catch {
      // keep existing items on error
    } finally {
      setIsLoadingFields(false);
    }
  }, [host]);

  // Debounced field loading when search changes
  const onSearchChange = useCallback((query: string) => {
    setSearch(query);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refreshFields(query);
    }, 800);
  }, [refreshFields]);

  // Load fields on mount
  useEffect(() => {
    refreshFields(config?.search ?? search);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    if (!search.trim()) return;
    onSave({
      search: search.trim(),
      title: title.trim() || undefined,
      visibleFields: selectedFields.length > 0 ? selectedFields : undefined,
      refreshInterval: refreshInterval || undefined,
    });
  };

  // Convert current selected fields to SelectItem[]
  const selectedSelectItems: FieldSelectItem[] = selectedFields.map(fieldToSelectItem);

  const handleFieldsChange = (selected: FieldSelectItem[]) => {
    setSelectedFields(selected.map(selectItemToField));
  };

  // Drag-and-drop handlers for column ordering
  const handleDragStart = useCallback((index: number) => {
    dragIndexRef.current = index;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((index: number) => {
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null || fromIndex === index) {
      dragIndexRef.current = null;
      setDragOverIndex(null);
      return;
    }
    setSelectedFields(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(index, 0, moved);
      return updated;
    });
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  const handleRemoveField = useCallback((index: number) => {
    setSelectedFields(prev => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <form className="ring-form" style={{padding: '8px 16px'}}>
      <span className="ring-form__title">Настройка виджета</span>

      <Input
        label="Заголовок (опционально)"
        value={title}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
      />

      <div style={{marginTop: 8, marginBottom: 4}}>
        <span style={{fontSize: 12, color: 'var(--ring-secondary-color)', display: 'block', marginBottom: 4}}>
          Поисковый запрос
        </span>
        <QueryAssist
          query={search}
          placeholder="project: DEMO State: Open"
          dataSource={queryAssistHandler}
          onChange={({query}) => onSearchChange(query)}
          onApply={({query}) => onSearchChange(query)}
          size={InputSize.M}
        />
      </div>

      <div style={{marginTop: 12, marginBottom: 8}}>
        <span style={{fontSize: 12, color: 'var(--ring-secondary-color)', display: 'block', marginBottom: 4}}>
          Колонки таблицы
        </span>
        {isLoadingFields && availableFieldItems.length === 0 ? (
          <LoaderInline />
        ) : (
          <Select
            multiple
            filter
            tags={{}}
            label="Выберите колонки"
            size={InputSize.FULL}
            data={availableFieldItems}
            selected={selectedSelectItems}
            onChange={handleFieldsChange}
            loading={isLoadingFields}
            notFoundMessage="Нет доступных полей"
          />
        )}
      </div>

      <div style={{marginTop: 12, marginBottom: 8}}>
        <span style={{fontSize: 12, color: 'var(--ring-secondary-color)', display: 'block', marginBottom: 4}}>
          Автообновление
        </span>
        <Select
          label="Частота обновления"
          size={InputSize.FULL}
          data={REFRESH_OPTIONS}
          selected={REFRESH_OPTIONS.find(o => o.key === refreshInterval)}
          onChange={(item: SelectItem | null) => setRefreshInterval((item?.key as number) ?? 0)}
        />
      </div>

      {/* Column order — drag to reorder */}
      {selectedFields.length > 1 && (
        <div style={{marginTop: 4, marginBottom: 8}}>
          <span style={{fontSize: 12, color: 'var(--ring-secondary-color)', display: 'block', marginBottom: 4}}>
            Порядок колонок (перетащите для изменения)
          </span>
          <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
            {selectedFields.map((fc, idx) => (
              <div
                key={fc.key}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  borderRadius: 3,
                  cursor: 'grab',
                  fontSize: 13,
                  background: dragOverIndex === idx
                    ? 'var(--ring-hover-background-color)'
                    : 'var(--ring-content-background-color)',
                  border: '1px solid var(--ring-borders-color)',
                  transition: 'background 0.1s',
                }}
              >
                <span style={{color: 'var(--ring-icon-secondary-color)', fontSize: 11}}>☰</span>
                <span style={{flex: 1}}>{fc.label}</span>
                <span
                  style={{
                    color: 'var(--ring-icon-secondary-color)',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: '0 2px',
                  }}
                  title="Убрать"
                  onClick={() => handleRemoveField(idx)}
                >
                  ×
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ButtonSet>
        <Button primary disabled={!search.trim()} onClick={handleSave}>
          Сохранить
        </Button>
        <Button onClick={onCancel}>
          Отмена
        </Button>
      </ButtonSet>
    </form>
  );
};

export const Configuration = memo(ConfigurationComponent);
