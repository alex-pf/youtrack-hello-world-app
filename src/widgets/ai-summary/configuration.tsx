import React, {memo, useState} from 'react';
import Input, {Size as InputSize} from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import type {WidgetConfig} from './types';

interface Props {
  config: WidgetConfig | null;
  onSave: (config: WidgetConfig) => void;
  onCancel: () => void;
}

const ConfigurationComponent: React.FC<Props> = ({config, onSave, onCancel}) => {
  const [search, setSearch] = useState(config?.search ?? '');
  const [prompt, setPrompt] = useState(config?.prompt ?? '');
  const [debugMode, setDebugMode] = useState(config?.debugMode ?? false);

  const canSave = search.trim().length > 0 && prompt.trim().length > 0;

  return (
    <div className="as-config">
      <div className="as-config-field">
        <label className="as-config-label">Фильтр YouTrack (query)</label>
        <Input
          size={InputSize.FULL}
          value={search}
          placeholder="project: DEMO #Unresolved"
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="as-config-field">
        <label className="as-config-label">Промпт для AI</label>
        <Input
          multiline
          size={InputSize.FULL}
          value={prompt}
          placeholder="Суммаризируй перечисленные задачи..."
          onChange={e => setPrompt(e.target.value)}
        />
      </div>

      <div className="as-config-field">
        <Checkbox
          label="Debug (показывать отладочную информацию)"
          checked={debugMode}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDebugMode(e.target.checked)}
        />
      </div>

      <ButtonSet>
        <Button
          primary
          disabled={!canSave}
          onClick={() => onSave({search: search.trim(), prompt: prompt.trim(), debugMode})}
        >
          Сохранить
        </Button>
        <Button onClick={onCancel}>Отмена</Button>
      </ButtonSet>
    </div>
  );
};

export const Configuration = memo(ConfigurationComponent);
