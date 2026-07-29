export interface WidgetConfig {
  search: string;
  prompt: string;
  debugMode: boolean;
}

/** Shape persisted by storeConfig — debugMode is stored as a 'true'/'false' string */
export interface StoredWidgetConfig {
  search: string;
  prompt: string;
  debugMode?: string;
}

export function parseStoredConfig(stored: StoredWidgetConfig | null): WidgetConfig | null {
  if (!stored || !stored.search || !stored.prompt) return null;
  return {
    search: stored.search,
    prompt: stored.prompt,
    debugMode: stored.debugMode === 'true'
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    prompt: config.prompt,
    debugMode: String(config.debugMode)
  };
}

export interface IssueFieldValue {
  name?: string;
  login?: string;
  fullName?: string;
  presentation?: string;
}

export interface IssueField {
  value: IssueFieldValue | IssueFieldValue[] | null;
  projectCustomField?: {field: {name: string; localizedName?: string}};
}

export interface Issue {
  idReadable: string;
  summary: string;
  description: string | null;
  fields: IssueField[];
}

export interface AskAiResponse {
  markdown?: string;
  error?: string;
}
