import React, {memo, useState} from 'react';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import type {WidgetConfig} from './types';

interface Props {
  config: WidgetConfig | null;
  onSave: (config: WidgetConfig) => void;
  onCancel: () => void;
}

const ConfigurationComponent: React.FC<Props> = ({config, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [title, setTitle] = useState(config?.title ?? '');

  const handleSave = () => {
    if (!search.trim()) return;
    onSave({search: search.trim(), title: title.trim() || undefined});
  };

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
