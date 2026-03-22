export interface FieldColumnConfig {
  key: string;       // field name (e.g. 'Priority') or built-in key ('created', 'updated')
  label: string;     // display label
  builtin?: boolean; // true for created/updated/resolved
}

export interface WidgetConfig {
  search: string;
  title?: string;
  visibleFields?: FieldColumnConfig[];
}

/** Shape persisted by storeConfig — visibleFields is a JSON string */
export interface StoredWidgetConfig {
  search: string;
  title?: string;
  visibleFields?: string;
}

export function parseStoredConfig(stored: StoredWidgetConfig | null): WidgetConfig | null {
  if (!stored) return null;
  let fields: FieldColumnConfig[] | undefined;
  if (stored.visibleFields) {
    try {
      fields = JSON.parse(stored.visibleFields) as FieldColumnConfig[];
    } catch {
      fields = undefined;
    }
  }
  return {
    search: stored.search,
    title: stored.title,
    visibleFields: fields,
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    title: config.title,
    visibleFields: config.visibleFields ? JSON.stringify(config.visibleFields) : undefined,
  };
}

export interface IssueFieldValue {
  id?: string;
  name?: string;
  localizedName?: string;
  login?: string;
  avatarUrl?: string;
  presentation?: string;
  minutes?: number;
  color?: {
    id: number;
    foreground: string;
    background: string;
  };
}

export interface ProjectCustomField {
  id: string;
  bundle?: { id: string };
  field: {
    id: string;
    name: string;
    localizedName?: string;
    fieldType?: {
      id: string;
      valueType: string;
    };
  };
}

export interface IssueField {
  id: string;
  value: IssueFieldValue | IssueFieldValue[] | null;
  projectCustomField: ProjectCustomField;
}

export interface Issue {
  id: string;
  idReadable: string;
  summary: string;
  resolved: number | null;
  created: number | null;
  updated: number | null;
  fields: IssueField[];
}
