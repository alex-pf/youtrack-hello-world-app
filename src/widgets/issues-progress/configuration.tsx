import React, {useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import {WidgetConfig, serializeConfig} from './types';

interface Props {
  config: WidgetConfig | null;
  host: EmbeddableWidgetAPI;
  onSave: (config: WidgetConfig) => void;
  onCancel: () => void;
}

export default function Configuration({config, host, onSave, onCancel}: Props) {
  const [search, setSearch] = useState(config?.search ?? '');

  const handleSave = async () => {
    const newConfig: WidgetConfig = {
      search,
      projects: [],
      statusOrder: [],
      ltEnabled: false,
      ltSettings: {},
      showEstimateDate: false,
      refreshInterval: 0,
    };
    await host.storeConfig(serializeConfig(newConfig));
    onSave(newConfig);
  };

  return (
    <form className="ring-form" style={{padding: '8px 16px'}}>
      <span className="ring-form__title">Issues Progress Settings</span>
      <Input
        label="Query Filter"
        value={search}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        placeholder="e.g. project: MyProject"
      />
      <p style={{color: 'var(--ring-secondary-color)', fontSize: '12px'}}>
        Full configuration UI coming in Phase 3.
      </p>
      <ButtonSet>
        <Button primary disabled={!search.trim()} onClick={handleSave}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </ButtonSet>
    </form>
  );
}