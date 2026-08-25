export interface WidgetConfig {
  search: string;
  prompt: string;
  title?: string;
  description?: string;
  includeComments: boolean;
  debugMode: boolean;
}

/** Shape persisted by storeConfig — booleans are stored as 'true'/'false' strings */
export interface StoredWidgetConfig {
  search: string;
  prompt: string;
  title?: string;
  description?: string;
  includeComments?: string;
  debugMode?: string;
}

export function parseStoredConfig(stored: StoredWidgetConfig | null): WidgetConfig | null {
  if (!stored || !stored.search || !stored.prompt) return null;
  return {
    search: stored.search,
    prompt: stored.prompt,
    title: stored.title,
    description: stored.description,
    includeComments: stored.includeComments === 'true',
    debugMode: stored.debugMode === 'true'
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    prompt: config.prompt,
    title: config.title,
    description: config.description,
    includeComments: String(config.includeComments),
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

export interface IssueLinkType {
  name: string;
  localizedName?: string;
  sourceToTarget: string;
  targetToSource: string;
}

export interface IssueLink {
  direction: 'INWARD' | 'OUTWARD' | 'BOTH';
  linkType: IssueLinkType;
  trimmedIssues: {idReadable: string; summary: string}[];
}

export interface Issue {
  id: string;
  idReadable: string;
  summary: string;
  description: string | null;
  fields: IssueField[];
  links: IssueLink[];
}

/** Response from POST ask-ai/ask — the AI call runs async, this just hands back a poll handle. */
export interface AskAiStartResponse {
  requestId?: string;
  error?: string;
}

/** Response from GET ask-ai/result — polled until status is no longer "pending". */
export interface AskAiResultResponse {
  status: 'pending' | 'done' | 'error';
  markdown?: string;
  error?: string;
}

// ─── Issue activity history (used to build a compact per-issue digest) ─────

export interface ActivityAuthor {
  login?: string;
  fullName?: string;
  name?: string;
}

export interface ActivityValue {
  name?: string;
  presentation?: string;
  login?: string;
  fullName?: string;
  text?: string;
  value?: string | number;
}

export interface IssueActivityItem {
  timestamp: number;
  author?: ActivityAuthor;
  category?: {id: string};
  field?: {name?: string; localizedName?: string};
  added?: ActivityValue | ActivityValue[] | null;
  removed?: ActivityValue | ActivityValue[] | null;
}

export interface ActivityPage {
  activities?: IssueActivityItem[];
  cursor?: string;
  hasAfter?: boolean;
}

/** idReadable → compact human-readable history digest */
export type HistoryDigest = Record<string, string>;
