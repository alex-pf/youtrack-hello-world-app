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
  login?: string;             // present on User-typed values (e.g. Assignee field changes)
  $type?: string;
  value?: number | string;   // Unix ms timestamp for DateIssueCustomField (API may return as string)
}

// ─── Issue link activities (child issues indicator) ─────────────────────────

// Mini-representation of an issue, as it arrives inside added/removed of a
// LinksCategory activity — NOT the same shape as ActivityValue (id/name/
// presentation/value), so it gets its own type rather than reusing that one.
export interface LinkedIssueRef {
  id: string;
  idReadable: string;
  summary?: string;   // may be absent in the activity payload — see resources.ts
}

// A single LinksCategory activity item. Extends the general activity shape
// with linkType/direction and added/removed in LinkedIssueRef[] form instead
// of ActivityValue[] — kept as a separate type (rather than folded into
// IssueActivityItem) so the existing custom-field activity parsing is left
// untouched.
export interface IssueLinkActivityItem {
  id: string;
  timestamp: number;
  author: ActivityAuthor;
  category: { id: string };        // confirmed "LinksCategory" against a live instance
  // For link activities, `field.name` is typically the DIRECTIONAL wording
  // used for this specific activity (e.g. "Родитель для" on the parent side,
  // "Подзадача для" on the child side of the very same link type) — unlike
  // linkType.sourceToTarget/targetToSource, which are static properties of
  // the link type itself and don't tell you which side fired. This is the
  // primary fallback signal when `direction` is absent — see
  // filterChildLinkActivities() in activity-parser.ts.
  field?: {
    id?: string;
    name?: string;
  };
  linkType?: {
    id?: string;
    name?: string;                 // neutral name, e.g. "Subtask"
    localizedName?: string;
    sourceToTarget?: string;       // e.g. "Родитель для" / "Parent for"
    targetToSource?: string;       // e.g. "Подзадача для" / "Subtask of"
    directed?: boolean;
  };
  direction?: 'OUTWARD' | 'INWARD' | 'BOTH' | string; // not guaranteed present on all API versions
  added: LinkedIssueRef[] | LinkedIssueRef | null;
  removed: LinkedIssueRef[] | LinkedIssueRef | null;
}

// Current ("as of now") child issue, from the issues/{id}/links API add-on.
export interface ChildIssueRef {
  id: string;
  idReadable: string;
  summary: string;
}

// One parsed change-in-child-composition event (internal parser model, before
// and after childrenAsOfEvent is filled in by buildChildrenTimeline). Per
// calendar day this is normally ONE event, EXCEPT when net === 0 due to an
// exact same-day add+remove compensation — see parseChildLinkChanges, which
// then emits TWO events for that day (one add-only, one remove-only).
export interface ChildLinkChangeEvent {
  changedAt: number;             // activity timestamp (post per-day merge)
  addedChildren: ChildIssueRef[];   // children added in this event/day
  removedChildren: ChildIssueRef[]; // children removed in this event/day
  // net > 0 -> green dot, net < 0 -> yellow dot (net === 0 never happens as
  // a single event — see parseChildLinkChanges for the split-into-two case)
  net: number;
  // Accumulated child list AS OF this event (after applying it) — the
  // tooltip's data source. Filled in by buildChildrenTimeline via a
  // backward pass from the current ("now") snapshot.
  childrenAsOfEvent: ChildIssueRef[];
}

// ─── Assignee change activities (assignee history indicator) ───────────────

// A resolved assignee reference — id + best-available display name
// (name ?? login ?? id). Used both for activity added/removed entries and
// for the current ("as of now") snapshot read off issue.fields.
export interface AssigneeRef {
  id: string;
  displayName: string;
}

// One parsed change-in-assignee-composition event (internal parser model,
// before and after assigneesAsOfEvent is filled in by
// buildAssigneesTimeline). Mirrors ChildLinkChangeEvent's per-day-merge +
// net===0-split model exactly — see parseAssigneeChanges in
// activity-parser.ts.
export interface AssigneeChangeEvent {
  changedAt: number;                 // activity timestamp (post per-day merge)
  addedAssignees: AssigneeRef[];      // assignees added in this event/day
  removedAssignees: AssigneeRef[];    // assignees removed in this event/day
  // net > 0 -> green triangle, net < 0 -> blue triangle (net === 0 never
  // happens as a single event — see parseAssigneeChanges for the
  // split-into-two case)
  net: number;
  // Accumulated assignee list AS OF this event (after applying it). Filled
  // in by buildAssigneesTimeline via a backward pass from the current
  // ("now") snapshot (extractCurrentAssignees).
  assigneesAsOfEvent: AssigneeRef[];
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
  | 'marker'   // a single point-in-time tick/dot (e.g. "estimate date changed here")
  | 'flag'     // a point-in-time marker with an adaptive inline label (e.g. current estimate date)
  | 'hatch'    // a diagonally-hatched date range (e.g. a blocked period)
  | 'dot'      // a small filled circle event (e.g. a child issue link added/removed)
  | 'triangle'; // an upward-pointing triangle pinned to the bottom of the status bar, with an inline count label (e.g. an assignee added/removed)

export interface ChartIndicator {
  kind: IndicatorKind;
  id: string;              // stable key for React/D3 data-join

  // Finer-grained "what is this indicator, semantically" tag, independent of
  // `kind`. `kind` only controls HOW something is drawn (tick / pole+pennant
  // / hatch); it's not granular enough to let the UI toggle individual
  // indicator producers on/off, since two different semantic indicators can
  // share the same `kind` (e.g. a future indicator might also be a
  // 'marker'). The indicator-visibility toggle panel in app.tsx keys off
  // this field. Optional for now since it's new — producers should set it,
  // but existing/omitted values just won't be independently toggleable.
  semanticType?: string;

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
