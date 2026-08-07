// Status with display order
export interface StatusOrderItem {
  id: string;
  name: string;
  color?: string;
}

// Grid step controlling the X-axis tick/gridline spacing on the Gantt chart.
// Unlike issue-state-history's GridStep (calendar 'day'|'week'|'month'), here
// the X axis is measured in lead-time days, so the step is a number of days
// between grid ticks — see docs/PROGRESS_TRACKING_SPEC.md section 8, item 2.
export type GridStep = 1 | 7 | 14 | 28;

const GRID_STEP_VALUES: GridStep[] = [1, 7, 14, 28];

// Row order for the chart:
// - 'startDate' — date the issue entered the configured start status (leadTimeStartAt)
// - 'issueNumber' — issue id, compared numerically (PROJ-2 before PROJ-10)
// - 'estimatedDate' — current Estimated Date field value
export type SortBy = 'startDate' | 'issueNumber' | 'estimatedDate';

// In-memory widget config (rich objects)
export interface WidgetConfig {
  title?: string;
  projects: string[];            // array of project IDs
  primarySearch: string;         // required — defines chart composition + percentile base
  additionalSearch: string;      // optional — narrows chart composition only
  groupByField: string;          // technical/localized name of the enum field to group by
  statusOrder: StatusOrderItem[]; // ordered list of statuses to display
  showProjectedLT: boolean;
  gridStep: GridStep;            // days between grid ticks, shared across all group charts
  sortBy: SortBy;
  refreshInterval: number;       // minutes; 0 = no auto-refresh
  debugMode: boolean;            // show status transition history below chart
  description?: string;          // markdown text shown below chart
}

// Stored widget config (flat primitives for host.storeConfig)
export interface StoredWidgetConfig {
  title?: string;
  projects?: string;            // JSON-encoded string[]
  primarySearch: string;
  additionalSearch?: string;
  groupByField?: string;
  statusOrder?: string;         // JSON-encoded StatusOrderItem[]
  showProjectedLT?: string;     // 'true' | 'false'
  gridStep?: number;
  sortBy?: string;
  refreshInterval?: number;
  debugMode?: string;           // 'true' | 'false'
  description?: string;
}

const SORT_BY_VALUES: SortBy[] = ['startDate', 'issueNumber', 'estimatedDate'];

function parseSortBy(value: string | undefined): SortBy {
  return SORT_BY_VALUES.includes(value as SortBy) ? (value as SortBy) : 'startDate';
}

function parseGridStep(value: number | undefined): GridStep {
  return GRID_STEP_VALUES.includes(value as GridStep) ? (value as GridStep) : 1;
}

export function parseStoredConfig(stored: Record<string, string>): WidgetConfig {
  return {
    title: stored.title,
    projects: stored.projects ? JSON.parse(stored.projects) : [],
    primarySearch: stored.primarySearch ?? '',
    additionalSearch: stored.additionalSearch ?? '',
    groupByField: stored.groupByField ?? '',
    statusOrder: stored.statusOrder ? JSON.parse(stored.statusOrder) : [],
    showProjectedLT: stored.showProjectedLT !== 'false',
    gridStep: parseGridStep(stored.gridStep ? Number(stored.gridStep) : undefined),
    sortBy: parseSortBy(stored.sortBy),
    refreshInterval: stored.refreshInterval ? Number(stored.refreshInterval) : 0,
    debugMode: stored.debugMode === 'true',
    description: stored.description ?? '',
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    title: config.title,
    projects: JSON.stringify(config.projects),
    primarySearch: config.primarySearch,
    additionalSearch: config.additionalSearch ?? '',
    groupByField: config.groupByField ?? '',
    statusOrder: JSON.stringify(config.statusOrder),
    showProjectedLT: String(config.showProjectedLT),
    gridStep: config.gridStep,
    sortBy: config.sortBy,
    refreshInterval: config.refreshInterval,
    debugMode: String(config.debugMode),
    description: config.description ?? '',
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
    localizedName?: string;
    fieldType: { id: string; valueType: string };
  };
  bundle?: {
    id: string;
    values: BundleValue[];
  };
}

// A candidate enum field for grouping, aggregated across the configured
// projects by field name (case-insensitive) — analogous to how states/types
// are aggregated by value name in issues-progress/resources.ts. Used to
// populate the "Group by" selector in configuration.tsx (increment 3) and
// returned by loadProjectCustomFields (see resources.ts).
export interface GroupableField {
  name: string;
  localizedName?: string;
  values: { id: string; name: string; ordinal?: number }[];
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
  groupValue?: string;         // value of the configured groupByField, for grouping into per-group charts
  // Segments in the order defined by statusOrder config
  segments: StatusSegment[];
  // Estimate date changes (deduplicated per day)
  estimateDateChanges: EstimateDateChange[];
  totalDays: number;           // sum of all segment days
  // Unix ms timestamp of the "lead time start" anchor — when the issue
  // first entered the configured start status (statusOrder[0]), or issue
  // creation time if it never reached that status (or none is configured).
  // This is the "day 0" reference for the Projected Lead Time marker —
  // deliberately NOT always issue creation, since time spent in
  // unconfigured statuses before the issue entered the tracked workflow
  // shouldn't count toward lead time.
  leadTimeStartAt?: number;
  projectedLeadTimeDays?: number;
  projectedLTDate?: number;
  // True when the issue never entered statusOrder[0] — segments fall back to
  // the full chronological history from creation instead of being anchored
  // at the configured start status.
  neverReachedStartStatus: boolean;
  // Current value of the Estimated Date field (read directly from
  // issue.fields, independent of showProjectedLT), for the "Estimated Date"
  // sort option. Null if the issue has no estimate set.
  estimatedDate: number | null;
}

export interface StatusSegment {
  statusName: string;
  statusId: string;
  durationDays: number;
  color?: string;              // from BundleValue.color.background
  // True when this segment's status is not present in the configured
  // statusOrder — rendered gray (with the real status name) instead of
  // being dropped from the timeline.
  isUnconfigured: boolean;
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
