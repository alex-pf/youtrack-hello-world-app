import React, {memo, useCallback, useEffect, useState} from 'react';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import {ControlsHeight} from '@jetbrains/ring-ui-built/components/global/controls-height';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {WidgetConfig, FieldColumnConfig} from './types';
import {BUILTIN_FIELDS, extractAvailableFields, loadIssues} from './resources';

interface Props {
  config: WidgetConfig | null;
  host: EmbeddableWidgetAPI;
  onSave: (config: WidgetConfig) => void;
  onCancel: () => void;
}

const ConfigurationComponent: React.FC<Props> = ({config, host, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [title, setTitle] = useState(config?.title ?? '');
  const [selectedFields, setSelectedFields] = useState<FieldColumnConfig[]>(
    config?.visibleFields ?? []
  );
  const [availableFields, setAvailableFields] = useState<FieldColumnConfig[]>([]);
  const [isLoadingFields, setIsLoadingFields] = useState(false);

  // Load available fields when search query is set
  const loadAvailableFields = useCallback(async (query: string) => {
    if (!query.trim()) {
      setAvailableFields([]);
      return;
    }
    setIsLoadingFields(true);
    try {
      const issues = await loadIssues(host, query.trim(), 0);
      const customFields = extractAvailableFields(issues);
      setAvailableFields(customFields);
    } catch {
      setAvailableFields([]);
    } finally {
      setIsLoadingFields(false);
    }
  }, [host]);

  // Load fields on mount if we already have a search query
  useEffect(() => {
    if (config?.search) {
      loadAvailableFields(config.search);
    }
  }, [config?.search, loadAvailableFields]);

  const handleLoadFields = () => {
    loadAvailableFields(search);
  };

  const isFieldSelected = (field: FieldColumnConfig): boolean => {
    return selectedFields.some(f => f.key === field.key);
  };

  const toggleField = (field: FieldColumnConfig) => {
    setSelectedFields(prev => {
      if (prev.some(f => f.key === field.key)) {
        return prev.filter(f => f.key !== field.key);
      }
      return [...prev, field];
    });
  };

  const handleSave = () => {
    if (!search.trim()) return;
    onSave({
      search: search.trim(),
      title: title.trim() || undefined,
      visibleFields: selectedFields.length > 0 ? selectedFields : undefined,
    });
  };

  const allFields = [...BUILTIN_FIELDS, ...availableFields];

  return (
    <form className="ring-form" style={{padding: '8px 16px'}}>
      <span className="ring-form__title">Настройка виджета</span>

      <Input
        label="Заголовок (опционально)"
        value={title}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
      />

      <Input
        label="Поисковый запрос"
        value={search}
        placeholder="project: DEMO State: Open"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
      />

      <div style={{marginTop: 12, marginBottom: 8}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8}}>
          <span className="ring-form__label" style={{margin: 0, fontSize: 13, fontWeight: 500}}>
            Отображаемые поля
          </span>
          {search.trim() && (
            <Button
              height={ControlsHeight.S}
              onClick={handleLoadFields}
              disabled={isLoadingFields}
            >
              {availableFields.length > 0 ? 'Обновить' : 'Загрузить поля'}
            </Button>
          )}
        </div>

        {isLoadingFields && <LoaderInline />}

        {!isLoadingFields && allFields.length > 0 && (
          <div style={{
            maxHeight: 200,
            overflowY: 'auto',
            border: '1px solid var(--ring-borders-color)',
            borderRadius: 3,
            padding: '4px 8px',
          }}>
            {allFields.map(field => (
              <div key={field.key} style={{padding: '2px 0'}}>
                <Checkbox
                  checked={isFieldSelected(field)}
                  onChange={() => toggleField(field)}
                  label={field.label}
                />
              </div>
            ))}
          </div>
        )}

        {!isLoadingFields && availableFields.length === 0 && search.trim() && (
          <div style={{
            fontSize: 12,
            color: 'var(--ring-secondary-color)',
            marginTop: 4,
          }}>
            Нажмите «Загрузить поля», чтобы увидеть доступные поля для выбранного запроса
          </div>
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
