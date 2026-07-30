export interface FieldColumnConfig {
  key: string;       // field name (e.g. 'Priority') or built-in key ('created', 'updated')
  label: string;     // display label
  builtin?: boolean; // true for created/updated/resolved
}

export interface WidgetConfig {
  search: string;
  title?: string;
  description?: string;
  visibleFields?: FieldColumnConfig[];
  refreshInterval?: number; // minutes (0 = disabled)
}

/** Shape persisted by storeConfig — visibleFields is a JSON string */
export interface StoredWidgetConfig {
  search: string;
  title?: string;
  description?: string;
  visibleFields?: string;
  refreshInterval?: number;
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
    description: stored.description,
    visibleFields: fields,
    refreshInterval: stored.refreshInterval,
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    title: config.title,
    description: config.description,
    visibleFields: config.visibleFields ? JSON.stringify(config.visibleFields) : undefined,
    refreshInterval: config.refreshInterval,
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
  // Single-value text/date/integer/float custom fields (e.g. "Reason for
  // blocking") often come back as a bare string/number rather than
  // `{ name, presentation, ... }` — same class of surprise as
  // DateIssueCustomField elsewhere in this project. Multi-value fields
  // (enum/user/version bundles) are always objects, never raw primitives.
  value: IssueFieldValue | IssueFieldValue[] | string | number | null;
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
