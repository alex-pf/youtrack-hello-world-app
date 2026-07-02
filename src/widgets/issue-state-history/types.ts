// Status with display order
export interface StatusOrderItem {
  id: string;
  name: string;
  color?: string;
}

// Grid step controlling the X-axis tick/gridline spacing on the Gantt chart.
export type GridStep = 'day' | 'week' | 'month';

// In-memory widget config (rich objects)
export interface WidgetConfig {
  search: string;
  title?: string;
  projects: string[];           // array of project IDs
  statusOrder: StatusOrderItem[]; // ordered list of statuses; first entry = "start" status
  refreshInterval: number;      // minutes; 0 = no auto-refresh
  debugMode: boolean;           // show status transition history below chart
  description?: string;         // markdown text shown below chart
  // X-axis grid/tick step. Defaults to 'day' when not set (finest granularity,
  // matches the widget's original calendar-date behavior before this setting
  // existed, so previously-saved configs keep looking the same).
  gridStep: GridStep;
}

// Stored widget config (flat primitives for host.storeConfig)
export interface StoredWidgetConfig {
  search: string;
  title?: string;
  projects?: string;            // JSON-encoded string[]
  statusOrder?: string;         // JSON-encoded StatusOrderItem[]
  refreshInterval?: number;
  debugMode?: string;           // 'true' | 'false'
  description?: string;
  gridStep?: string;            // 'day' | 'week' | 'month'
}

export function parseStoredConfig(stored: Record<string, string>): WidgetConfig {
  return {
    search: stored.search ?? '',
    title: stored.title,
    projects: stored.projects ? JSON.parse(stored.projects) : [],
    statusOrder: stored.statusOrder ? JSON.parse(stored.statusOrder) : [],
    refreshInterval: stored.refreshInterval ? Number(stored.refreshInterval) : 0,
    debugMode: stored.debugMode === 'true',
    description: stored.description ?? '',
    gridStep: (stored.gridStep as GridStep) || 'day',
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    title: config.title,
    projects: JSON.stringify(config.projects),
    statusOrder: JSON.stringify(config.statusOrder),
    refreshInterval: config.refreshInterval,
    debugMode: String(config.debugMode),
    description: config.description ?? '',
    gridStep: config.gridStep,
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

// ─── Chart data ──────────────────────────────────────────────────────────────

// A single interval an issue spent in one status, expressed as absolute
// calendar timestamps (not durations) — used for the calendar-date X axis.
export interface DateSegment {
  // Configured status id, or null when the status is not present in
  // statusOrder (see isUnconfigured).
  statusId: string | null;
  statusName: string;
  startDate: number;   // Unix ms — when the issue entered this status
  endDate: number;      // Unix ms — when the issue left this status (or now/resolved for the last segment)
  // True when statusName was not found in the configured statusOrder list.
  // Segments like this must still be rendered (as gray bars), not dropped.
  isUnconfigured: boolean;
}

export interface IssueStateHistoryData {
  issueId: string;              // internal ID
  idReadable: string;           // e.g. "PROJ-123"
  summary: string;
  segments: DateSegment[];      // chronological list of status intervals
  overallStart: number;         // Unix ms — start of the first segment
  overallEnd: number;           // Unix ms — end of the last segment
  // True when the issue never entered the configured start status
  // (statusOrder[0]). Its segments start from issue creation instead of
  // the start-status entry time. Consumers can use this to visually flag
  // such issues (e.g. a note in a tooltip or a legend marker) — segments
  // before reaching the start status are typically already unconfigured
  // (isUnconfigured: true) and render gray, but this flag makes the
  // "never reached start status" case explicit at the issue level.
  neverReachedStartStatus: boolean;
  // Optional row-level annotations drawn on top of the status segments
  // (e.g. estimate-date-change markers, an estimate-date flag, blocking
  // hatching). Empty/undefined until a later task adds a producer — see
  // ChartIndicator below for the shared data contract.
  indicators?: ChartIndicator[];
}

// ─── Chart indicators ───────────────────────────────────────────────────────
// A uniform data contract for point/range annotations drawn on top of an
// issue row's status segments. Each concrete indicator "type" (estimate-date
// -change marker, estimate-date flag, blocking-period hatch, ...) is just a
// producer that builds ChartIndicator instances; gantt-chart.tsx has exactly
// ONE rendering path that switches on `kind` to draw them, and one shared
// tooltip mechanism for all of them. Extend IndicatorKind as new visual
// treatments are needed — keep this shape minimal, don't add fields without
// a concrete consumer.
export type IndicatorKind =
  | 'marker' // a single point-in-time tick/dot (e.g. "estimate date changed here")
  | 'flag'   // a point-in-time marker with an adaptive inline label (e.g. current estimate date)
  | 'hatch'; // a diagonally-hatched date range (e.g. a blocked period)

export interface ChartIndicator {
  kind: IndicatorKind;
  id: string;              // stable key for React/D3 data-join

  // Point-in-time indicators (marker, flag).
  date?: number;            // Unix ms

  // Range indicators (hatch).
  rangeStart?: number;      // Unix ms
  rangeEnd?: number;        // Unix ms

  // Adaptive label text shown inline next to a 'flag' indicator when there's
  // room (see the label-fit heuristic in gantt-chart.tsx). Ignored by other
  // kinds. Always shown in full inside the tooltip regardless of inline fit.
  label?: string;

  // Shared tooltip content — reuses the existing buildTooltipHtml/tooltipRef
  // mechanism, so every indicator kind gets a consistent hover tooltip for
  // free without each producer reimplementing it.
  tooltipTitle: string;
  tooltipRows: { label: string; value: string }[];

  // Optional override color. When omitted, rendering falls back to a
  // per-kind default (see gantt-chart.tsx / gantt-chart.css).
  color?: string;
}
