import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  IssueChartData,
  StatusSegment,
  EstimateDateChange,
  StatusOrderItem,
} from './types';
import { extractIssueTypeName, extractCurrentState } from './resources';

// ─── State Timeline Entry ─────────────────────────────────────────────────────

/**
 * A single entry in the raw state transition timeline for an issue.
 * Represents the moment the issue entered a particular state.
 */
export interface StateTimelineEntry {
  /** Unix ms timestamp when the issue entered this state */
  timestamp: number;
  /** Human-readable state name */
  stateName: string;
  /** YouTrack state bundle element ID */
  stateId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function msToDays(ms: number): number {
  return ms / MS_PER_DAY;
}

function toDateString(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

function toActivityValueArray(val: ActivityValue[] | ActivityValue | null): ActivityValue[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function isNumberValue(v: unknown): v is number {
  return typeof v === 'number' && v > 0;
}

/**
 * Shared match criterion between a timeline entry's (stateName, stateId) and
 * a target status: match by id OR by name (case-insensitive) — NOT
 * id-exclusive. On a dashboard whose search spans multiple projects, the
 * same-named state (e.g. "Dev of Arch") can have a DIFFERENT bundle element
 * id per project, since state fields are typically configured per-project
 * rather than shared. Name is the more reliable cross-project signal here,
 * since that's what the user actually picked in the Status Order config.
 *
 * Used by both findLeadTimeStartAt (the "day 0" anchor) and
 * parseStateSegments (the segment start-trim point), so the two stay
 * consistent — segments should start exactly at the same point that anchors
 * the Estimated Date / Projected Lead Time markers.
 */
function matchesStatus(
  stateName: string,
  stateId: string,
  target: { id: string; name: string }
): boolean {
  return (
    (!!stateId && !!target.id && stateId === target.id) ||
    stateName.toLowerCase() === target.name.toLowerCase()
  );
}

/**
 * Filters and sorts activity items to only state-change events.
 * Shared by parseStateSegments and parseStateTimeline.
 */
function filterStateActivities(activities: IssueActivityItem[]): IssueActivityItem[] {
  return activities
    .filter((a) => {
      // Method 2: Check $type on added/removed values — language-independent
      const addedArr = toActivityValueArray(a.added);
      const removedArr = toActivityValueArray(a.removed);
      const allVals = [...addedArr, ...removedArr];
      if (allVals.some((v) => v.$type?.toLowerCase().includes('state'))) return true;

      // Method 3: Check field name — covers English and common localizations
      const fieldName = a.field?.name?.toLowerCase() ?? '';
      if (
        fieldName === 'state' ||
        fieldName === 'status' ||
        fieldName === 'состояние' ||  // Russian
        fieldName === 'статус' ||      // Russian alternative
        fieldName === 'estado' ||      // Spanish/Portuguese
        fieldName === 'zustand' ||     // German
        fieldName === 'état'           // French
      ) return true;

      return false;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── State History Parser ─────────────────────────────────────────────────────

/**
 * Parses raw activity items for a single issue and returns time-in-status segments,
 * in CHRONOLOGICAL order (not grouped/aggregated by status).
 *
 * Algorithm:
 * 1. Build the raw chronological state timeline via parseStateTimeline() (shared
 *    with the debug view, so there's a single source of truth for "what happened when").
 * 2. If no statusOrder is configured, preserve the OLD aggregate-by-status-name
 *    behavior for backward compatibility (no chronology, no gray segments).
 * 3. Otherwise, walk the timeline in order and emit ONE segment per timeline
 *    entry (no aggregation across revisits) — configured statuses keep their
 *    color, everything else is flagged isUnconfigured so it can be rendered
 *    gray instead of being dropped.
 * 4. Trim the segment list so it STARTS at the first segment that matches
 *    statusOrder[0] (same id-or-name criterion as findLeadTimeStartAt), so the
 *    Gantt timeline and the lead-time anchor agree on "day 0". If the issue
 *    never reached statusOrder[0], fall back to the full history and flag
 *    neverReachedStartStatus.
 *
 * @param issueId - Internal issue ID (for logging)
 * @param activities - Raw activity items from GET issues/{id}/activities
 * @param statusOrder - Ordered list of statuses from widget config
 * @param issueCreatedAt - Issue creation timestamp (used as start time if no initial state change found)
 * @returns segments (chronological order) and whether the issue ever reached statusOrder[0]
 */
export function parseStateSegments(
  issueId: string,
  activities: IssueActivityItem[],
  statusOrder: StatusOrderItem[],
  issueCreatedAt: number,
  currentState?: { id: string; name: string }
): { segments: StatusSegment[]; neverReachedStartStatus: boolean } {
  let timeline = parseStateTimeline(activities, issueCreatedAt);

  // Fallback: no state-change activity at all — the issue was created
  // directly into a state (e.g. bulk import/seed data) rather than via a
  // logged transition. Synthesize a single-entry timeline from its current
  // State field value so it still gets a visible segment instead of an
  // empty bar.
  if (timeline.length === 0 && currentState) {
    timeline = [{ timestamp: issueCreatedAt, stateName: currentState.name, stateId: currentState.id }];
  }

  if (timeline.length === 0) {
    return { segments: [], neverReachedStartStatus: statusOrder.length > 0 };
  }

  const now = Date.now();

  if (statusOrder.length === 0) {
    // Preserve OLD behavior exactly: aggregate duration by status name,
    // no chronology, no gray/unconfigured concept — nothing is configured
    // so there's nothing to distinguish as "unconfigured".
    const durationByStatus = new Map<string, { id: string; durationMs: number }>();

    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i];
      const nextTimestamp = i < timeline.length - 1 ? timeline[i + 1].timestamp : now;
      const durationMs = nextTimestamp - entry.timestamp;
      if (durationMs <= 0) continue;

      const existing = durationByStatus.get(entry.stateName);
      if (existing) {
        existing.durationMs += durationMs;
      } else {
        durationByStatus.set(entry.stateName, { id: entry.stateId, durationMs });
      }
    }

    const segments: StatusSegment[] = Array.from(durationByStatus.entries()).map(
      ([name, val]) => ({
        statusName: name,
        statusId: val.id,
        durationDays: msToDays(val.durationMs),
        isUnconfigured: false,
      })
    );
    return { segments, neverReachedStartStatus: false };
  }

  // statusOrder.length > 0 — new chronological logic.
  const startStatus = statusOrder[0];

  // Build id/name lookup maps once, up front, for resolving each timeline
  // entry to its configured StatusOrderItem (for color lookup).
  const byId = new Map<string, StatusOrderItem>();
  const byName = new Map<string, StatusOrderItem>();
  for (const s of statusOrder) {
    byId.set(s.id, s);
    byName.set(s.name.toLowerCase(), s);
  }

  function resolveConfigured(stateName: string, stateId: string): StatusOrderItem | undefined {
    if (stateId && byId.has(stateId)) return byId.get(stateId);
    return byName.get(stateName.toLowerCase());
  }

  const allSegments: StatusSegment[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const nextTimestamp = i < timeline.length - 1 ? timeline[i + 1].timestamp : now;
    const durationMs = nextTimestamp - entry.timestamp;
    if (durationMs <= 0) continue; // skip degenerate/duplicate-timestamp intervals

    const configured = resolveConfigured(entry.stateName, entry.stateId);
    allSegments.push({
      statusName: entry.stateName,
      statusId: configured ? configured.id : (entry.stateId || ''),
      durationDays: msToDays(durationMs),
      color: configured?.color,
      isUnconfigured: !configured,
    });
  }

  // Trim so the timeline starts at the FIRST segment matching statusOrder[0]
  // — same id-or-name criterion as findLeadTimeStartAt, so the Gantt bar and
  // the lead-time/Estimated-Date anchor line up on the same "day 0".
  const startIndex = allSegments.findIndex((seg) =>
    matchesStatus(seg.statusName, seg.statusId, startStatus)
  );

  if (startIndex === -1) {
    // Issue never entered statusOrder[0] — show the full history instead of
    // an empty chart, but flag it so callers/renderers can indicate this.
    return { segments: allSegments, neverReachedStartStatus: true };
  }
  return { segments: allSegments.slice(startIndex), neverReachedStartStatus: false };
}

// ─── Raw State Timeline (for debug view) ─────────────────────────────────────

/**
 * Returns the raw ordered timeline of state entries for a single issue,
 * without any aggregation or filtering by statusOrder.
 *
 * Each entry represents the moment the issue entered a state.
 * The first entry uses `issueCreatedAt` as its timestamp (the initial state
 * before any recorded transition).
 *
 * @param issueId - Internal issue ID (unused, kept for API symmetry)
 * @param activities - Raw activity items from loadIssueActivities()
 * @param issueCreatedAt - Issue creation timestamp (Unix ms)
 * @returns Ordered array of StateTimelineEntry, earliest first
 */
export function parseStateTimeline(
  activities: IssueActivityItem[],
  issueCreatedAt: number
): StateTimelineEntry[] {
  // Filter to state-change activities only (same logic as parseStateSegments)
  const stateChanges = filterStateActivities(activities);

  if (stateChanges.length === 0) return [];

  const timeline: StateTimelineEntry[] = [];

  for (const activity of stateChanges) {
    const removedVals = toActivityValueArray(activity.removed);
    const addedVals = toActivityValueArray(activity.added);

    const fromStateName = removedVals[0]?.name ?? removedVals[0]?.presentation ?? '';
    const toStateName = addedVals[0]?.name ?? addedVals[0]?.presentation ?? '';
    const toStateId = addedVals[0]?.id ?? '';

    // First transition: record the initial "from" state starting at issue creation
    if (timeline.length === 0 && fromStateName) {
      const fromStateId = removedVals[0]?.id ?? '';
      timeline.push({
        timestamp: issueCreatedAt,
        stateName: fromStateName,
        stateId: fromStateId,
      });
    }

    if (toStateName) {
      timeline.push({
        timestamp: activity.timestamp,
        stateName: toStateName,
        stateId: toStateId,
      });
    }
  }

  return timeline;
}

/**
 * Finds the timestamp the issue FIRST entered the configured "start" status
 * (statusOrder[0]) — the "day 0" anchor for the Estimated Date ticks and the
 * Projected Lead Time marker, used INSTEAD OF issue creation time: time
 * spent in unconfigured statuses before the issue entered the tracked
 * workflow shouldn't count toward lead time.
 *
 * Falls back to issueCreatedAt when the issue never reached the start
 * status (or none is configured) — mirrors the issue-state-history widget's
 * buildDateSegments()/neverReachedStartStatus fallback.
 *
 * @param activities - Raw activity items
 * @param statusOrder - Ordered statuses from widget config; statusOrder[0] is the "start" status
 * @param issueCreatedAt - Issue creation timestamp (fallback)
 */
export function findLeadTimeStartAt(
  activities: IssueActivityItem[],
  statusOrder: StatusOrderItem[],
  issueCreatedAt: number
): number {
  if (statusOrder.length === 0) return issueCreatedAt;

  const startStatus = statusOrder[0];
  const timeline = parseStateTimeline(activities, issueCreatedAt);

  // Match by id OR by name (see matchesStatus doc comment) — NOT
  // id-only-when-both-present. Shared with parseStateSegments' start-trim
  // logic so the Gantt timeline and this "day 0" anchor never disagree.
  const entry = timeline.find((e) => matchesStatus(e.stateName, e.stateId, startStatus));
  return entry?.timestamp ?? issueCreatedAt;
}

// ─── Estimate Date History Parser ─────────────────────────────────────────────

/**
 * Parses raw activity items for a single issue and returns estimate date changes.
 *
 * Rules:
 * - Only include activities where field.name matches 'Estimated Date', 'Due Date', or similar date fields
 * - Same-day deduplication: if multiple changes happen on the same calendar day (YYYY-MM-DD),
 *   keep only the LAST change of that day (highest timestamp)
 * - The `fromDate` and `toDate` are Unix ms timestamps (or null if cleared/not set)
 *
 * @param issueId - Internal issue ID
 * @param activities - Raw activity items
 * @returns Array of EstimateDateChange objects, one per unique day, sorted by date ascending
 */
export function parseEstimateDateChanges(
  issueId: string,
  activities: IssueActivityItem[]
): EstimateDateChange[] {
  // Filter to estimate date field changes
  // Common field names: 'Estimated Date', 'Due Date', 'Estimate', 'Deadline'
  const dateChanges = activities
    .filter((a) => {
      const fieldName = a.field?.name?.toLowerCase() ?? '';
      return (
        fieldName.includes('estimated') ||
        fieldName.includes('due date') ||
        fieldName.includes('deadline')
        // Note: customField no longer available (field is FilterField) — match by name only
      );
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  if (dateChanges.length === 0) return [];

  // Group by day — keep last change per day
  const byDay = new Map<string, IssueActivityItem>();
  for (const activity of dateChanges) {
    const day = toDateString(activity.timestamp);
    byDay.set(day, activity); // overwrites earlier changes on same day
  }

  // Convert to EstimateDateChange objects
  const result: EstimateDateChange[] = [];
  for (const [day, activity] of byDay.entries()) {
    const removedVals = toActivityValueArray(activity.removed);
    const addedVals = toActivityValueArray(activity.added);

    // Date field values come as numbers or strings (Unix ms) or null
    const parseDate = (vals: ActivityValue[]): number | null => {
      if (vals.length === 0) return null;
      const val = vals[0];

      // PRIMARY: accept both number and string representation of Unix ms timestamp
      if (val.value !== undefined && val.value !== null) {
        const ts = Number(val.value);
        if (!isNaN(ts) && ts > 0) return ts;
      }

      // FALLBACK 1: val.id as numeric timestamp or ISO date string (YouTrack date-only fields return "YYYY-MM-DD")
      if (val.id) {
        const ts = Number(val.id);
        if (!isNaN(ts) && ts > 0) return ts;
        const isoTs = Date.parse(val.id);
        if (!isNaN(isoTs) && isoTs > 0) return isoTs;
      }

      // FALLBACK 2: presentation string (last resort)
      if (val.presentation) {
        const parsed = Date.parse(val.presentation);
        return isNaN(parsed) ? null : parsed;
      }

      return null;
    };

    result.push({
      issueId,
      changedAt: activity.timestamp,
      changedAtDay: day,
      fromDate: parseDate(removedVals),
      toDate: parseDate(addedVals),
      author: activity.author?.name ?? activity.author?.login ?? 'Unknown',
    });
  }

  // Sort by date ascending
  result.sort((a, b) => a.changedAt - b.changedAt);
  return result;
}

// Read the current Estimated Date directly from issue.fields (most reliable source).
// For DateIssueCustomField, YouTrack returns value as a Unix ms number.
function getEstimateDateFromFields(issue: Issue): number | null {
  if (!issue.fields) return null;
  const field = issue.fields.find(f => {
    const name = f.projectCustomField?.field?.name?.toLowerCase() ?? '';
    return name.includes('estimated') || name.includes('due date') || name.includes('deadline');
  });
  if (!field) return null;
  const val: unknown = field.value;
  if (isNumberValue(val)) return val;
  return null;
}

/**
 * Computes projected lead time (days) and the target date for an issue.
 * Prefers the current field value from issue.fields, falls back to activity history.
 *
 * @param leadTimeStartAt - "day 0" anchor (see findLeadTimeStartAt) — when
 *   the issue entered the configured start status, NOT issue creation.
 * @returns { days, date } or null if no estimate date is available
 */
function calculateProjectedLeadTime(
  issue: Issue,
  estimateDateChanges: EstimateDateChange[],
  leadTimeStartAt: number
): { days: number; date: number } | null {
  const lastChange = estimateDateChanges[estimateDateChanges.length - 1];
  const estimatedDateMs =
    getEstimateDateFromFields(issue) ??
    lastChange?.toDate ??
    lastChange?.fromDate ??
    null;
  if (estimatedDateMs === null) return null;
  const days = (estimatedDateMs - leadTimeStartAt) / (24 * 60 * 60 * 1000);
  if (days <= 0) return null;
  return { days, date: estimatedDateMs };
}

// ─── Main Aggregator ──────────────────────────────────────────────────────────

/**
 * Combines issue data with its activity history to produce chart-ready IssueChartData.
 *
 * @param issue - Issue object from loadIssues()
 * @param activities - Activity items from loadIssueActivities()
 * @param statusOrder - Ordered statuses from widget config
 * @param showEstimateDate - Whether to parse estimate date history
 * @param showProjectedLT - Whether to show the projected lead time marker
 * @returns IssueChartData ready for the Gantt chart
 */
export function buildIssueChartData(
  issue: Issue,
  activities: IssueActivityItem[],
  statusOrder: StatusOrderItem[],
  showEstimateDate: boolean,
  showProjectedLT: boolean = false
): IssueChartData {
  const issueCreatedAt = issue.created ?? Date.now();
  const { segments, neverReachedStartStatus } = parseStateSegments(
    issue.id,
    activities,
    statusOrder,
    issueCreatedAt,
    extractCurrentState(issue)
  );

  // Parse estimate date changes when needed by either flag
  const estimateDateChanges = (showEstimateDate || showProjectedLT)
    ? parseEstimateDateChanges(issue.id, activities)
    : [];

  // "Day 0" anchor for both the Estimated Date ticks (gantt-chart.tsx) and
  // the Projected Lead Time marker below — when the issue entered the
  // configured start status, not issue creation (see findLeadTimeStartAt).
  const leadTimeStartAt = findLeadTimeStartAt(activities, statusOrder, issueCreatedAt);

  // Projected Lead Time: prefer current field value (reliable), fall back to activity history.
  const projectedLT = showProjectedLT
    ? calculateProjectedLeadTime(issue, estimateDateChanges, leadTimeStartAt)
    : null;
  const projectedLeadTimeDays = projectedLT?.days;
  const projectedLTDate = projectedLT?.date;

  const totalDays = segments.reduce((sum, s) => sum + s.durationDays, 0);

  const issueType = extractIssueTypeName(issue);

  return {
    issueId: issue.id,
    idReadable: issue.idReadable,
    summary: issue.summary,
    issueType,
    segments,
    estimateDateChanges,
    totalDays,
    projectedLeadTimeDays,
    projectedLTDate,
    leadTimeStartAt,
    neverReachedStartStatus,
  };
}

/**
 * Processes all issues with their activities into chart data.
 * Filters out issues with no segments (no state history).
 *
 * @param issues - Array of issues from loadIssues()
 * @param activitiesMap - Map of issueId → activities from loadActivitiesBatch()
 * @param statusOrder - Ordered statuses from widget config
 * @param showEstimateDate - Whether to parse estimate date history
 * @param showProjectedLT - Whether to show the projected lead time marker
 * @returns Array of IssueChartData sorted by totalDays descending
 */
export function buildChartData(
  issues: Issue[],
  activitiesMap: Map<string, IssueActivityItem[]>,
  statusOrder: StatusOrderItem[],
  showEstimateDate: boolean,
  showProjectedLT: boolean = false
): IssueChartData[] {
  const chartData: IssueChartData[] = [];

  for (const issue of issues) {
    const activities = activitiesMap.get(issue.id) ?? [];
    const data = buildIssueChartData(issue, activities, statusOrder, showEstimateDate, showProjectedLT);
    // Include issues even with no segments (they'll show as empty rows)
    chartData.push(data);
  }

  // Sort by totalDays descending (longest issues at top)
  chartData.sort((a, b) => b.totalDays - a.totalDays);

  return chartData;
}