export interface WidgetConfig {
  search: string;
  prompt: string;
}

export function parseStoredConfig(stored: WidgetConfig | null): WidgetConfig | null {
  if (!stored || !stored.search || !stored.prompt) return null;
  return {search: stored.search, prompt: stored.prompt};
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
  markdown: string;
}
