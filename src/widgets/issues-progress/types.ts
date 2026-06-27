// Lead time thresholds per issue type (days)
export interface LtThreshold {
  lt50?: number;  // LT 50% in days
  lt80?: number;  // LT 80% in days
}

// Map of issue type name → LT thresholds
export type LtSettings = Record<string, LtThreshold>;

// Status with display order
export interface StatusOrderItem {
  id: string;
  name: string;
  color?: string;
}

// In-memory widget config (rich objects)
export interface WidgetConfig {
  search: string;
  title?: string;
  projects: string[];           // array of project IDs
  statusOrder: StatusOrderItem[]; // ordered list of statuses to display
  ltEnabled: boolean;
  ltSettings: LtSettings;       // per-type LT thresholds
  showEstimateDate: boolean;
  showProjectedLT: boolean;
  refreshInterval: number;      // minutes; 0 = no auto-refresh
  debugMode: boolean;           // show status transition history below chart
}

// Stored widget config (flat primitives for host.storeConfig)
export interface StoredWidgetConfig {
  search: string;
  title?: string;
  projects?: string;            // JSON-encoded string[]
  statusOrder?: string;         // JSON-encoded StatusOrderItem[]
  ltEnabled?: string;           // 'true' | 'false'
  ltSettings?: string;          // JSON-encoded LtSettings
  showEstimateDate?: string;    // 'true' | 'false'
  showProjectedLT?: string;
  refreshInterval?: number;
  debugMode?: string;           // 'true' | 'false'
}

export function parseStoredConfig(stored: Record<string, string>): WidgetConfig {
  return {
    search: stored.search ?? '',
    title: stored.title,
    projects: stored.projects ? JSON.parse(stored.projects) : [],
    statusOrder: stored.statusOrder ? JSON.parse(stored.statusOrder) : [],
    ltEnabled: stored.ltEnabled === 'true',
    ltSettings: stored.ltSettings ? JSON.parse(stored.ltSettings) : {},
    showEstimateDate: stored.showEstimateDate === 'true',
    showProjectedLT: stored.showProjectedLT !== 'false',
    refreshInterval: stored.refreshInterval ? Number(stored.refreshInterval) : 0,
    debugMode: stored.debugMode === 'true',
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    title: config.title,
    projects: JSON.stringify(config.projects),
    statusOrder: JSON.stringify(config.statusOrder),
    ltEnabled: String(config.ltEnabled),
    ltSettings: JSON.stringify(config.ltSettings),
    showEstimateDate: String(config.showEstimateDate),
    showProjectedLT: String(config.showProjectedLT),
    refreshInterval: config.refreshInterval,
    debugMode: String(config.debugMode),
  };
}
// ─── YouTrack API response types ───────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  shortName: string;
}

export interface BundleValue {
  id: string;
  name: string;
  color?: { id: string; background: string; foreground: string };
  ordinal?: number;
  isResolved?: boolean;
}

export interface ProjectCustomFieldInfo {
  id: string;
  field: {
    id: string;
    name: string;
    fieldType: { id: string; valueType: string };
  };
  bundle?: {
    id: string;
    values: BundleValue[];
  };
}

export interface IssueType {
  id: string;
  name: string;
}

// ─── Activity / History types ───────────────────────────────────────────────

export interface ActivityAuthor {
  id: string;
  name: string;
  login: string;
}

// A single activity item from GET issues/{id}/activities
export interface IssueActivityItem {
  id: string;
  timestamp: number;           // Unix ms
  author: ActivityAuthor;
  category: { id: string };    // e.g. "CustomFieldChanges", "IssueResolvedChanges"
  field?: {
    id: string;
    name: string;
  };
  added: ActivityValue[] | ActivityValue | null;
  removed: ActivityValue[] | ActivityValue | null;
}

// Wrapper returned by GET issues/{id}/activitiesPage (cursor-based pagination)
export interface ActivityPage {
  activities?: IssueActivityItem[];
  cursor?: string;
  hasAfter?: boolean;
}

export interface ActivityValue {
  id?: string;
  name?: string;
  presentation?: string;
  $type?: string;
  value?: number | string;   // Unix ms timestamp for DateIssueCustomField (API may return as string)
}

// Parsed state change: issue spent `days` in `fromState` before moving to `toState`
export interface StateChange {
  issueId: string;
  fromState: string;           // state name
  toState: string;             // state name
  enteredAt: number;           // Unix ms when entered fromState
  exitedAt: number;            // Unix ms when exited fromState (entered toState)
  durationMs: number;
  durationDays: number;
}

// Parsed estimate date change
export interface EstimateDateChange {
  issueId: string;
  changedAt: number;           // Unix ms
  changedAtDay: string;        // YYYY-MM-DD (for same-day deduplication)
  fromDate: number | null;     // Unix ms or null
  toDate: number | null;       // Unix ms or null
  author: string;
}

// Aggregated per-issue data ready for chart rendering
export interface IssueChartData {
  issueId: string;             // internal ID
  idReadable: string;          // e.g. "PROJ-123"
  summary: string;
  issueType?: string;          // issue type name (for LT lookup)
  // Segments in the order defined by statusOrder config
  segments: StatusSegment[];
  // Estimate date changes (deduplicated per day)
  estimateDateChanges: EstimateDateChange[];
  totalDays: number;           // sum of all segment days
  projectedLeadTimeDays?: number;
  projectedLTDate?: number;
}

export interface StatusSegment {
  statusName: string;
  statusId: string;
  durationDays: number;
  color?: string;              // from BundleValue.color.background
}

// ─── Issue types (for fetching issues list) ─────────────────────────────────

export interface IssueFieldValue {
  id?: string;
  name?: string;
  localizedName?: string;
  login?: string;
  avatarUrl?: string;
  presentation?: string;
  minutes?: number;
  color?: { id: string; foreground: string; background: string };
}

export interface ProjectCustomField {
  id: string;
  bundle?: { id: string };
  field: {
    id: string;
    name: string;
    localizedName?: string;
    fieldType: { id: string; valueType: string };
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