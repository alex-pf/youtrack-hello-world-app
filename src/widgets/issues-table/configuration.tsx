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

const ConfigurationComponent: React.FC<Props> = ({config, host, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [title, setTitle] = useState(config?.title ?? '');
  const [selectedFields, setSelectedFields] = useState<FieldColumnConfig[]>(
    config?.visibleFields ?? []
  );
  const [availableFieldItems, setAvailableFieldItems] = useState<FieldSelectItem[]>([]);
  const [isLoadingFields, setIsLoadingFields] = useState(false);

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
    });
  };

  // Convert current selected fields to SelectItem[]
  const selectedSelectItems: FieldSelectItem[] = selectedFields.map(fieldToSelectItem);

  const handleFieldsChange = (selected: FieldSelectItem[]) => {
    setSelectedFields(selected.map(selectItemToField));
  };

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
          Отображаемые поля
        </span>
        {isLoadingFields && availableFieldItems.length === 0 ? (
          <LoaderInline />
        ) : (
          <Select
            multiple
            filter
            tags={{}}
            label="Выберите поля"
            size={InputSize.FULL}
            data={availableFieldItems}
            selected={selectedSelectItems}
            onChange={handleFieldsChange}
            loading={isLoadingFields}
            notFoundMessage="Нет доступных полей"
          />
        )}
      </div>

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
