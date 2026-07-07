import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  IssueChartData,
  StatusSegment,
  EstimateDateChange,
  StatusOrderItem,
} from './types';
import { extractIssueTypeName } from './resources';

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
 * Parses raw activity items for a single issue and returns time-in-status segments.
 *
 * Algorithm:
 * 1. Filter activities to only state-change events (field.name === 'State' or category CustomFieldChanges with state field)
 * 2. Sort by timestamp ascending
 * 3. Walk through transitions: for each transition, compute duration from previous transition timestamp to current
 * 4. Map each (stateName, durationMs) pair to a StatusSegment using the statusOrder config for color lookup
 * 5. Only include segments for statuses that are in statusOrder (filter out unlisted statuses)
 * 6. If statusOrder is empty, include all statuses found in history
 *
 * @param issueId - Internal issue ID (for logging)
 * @param activities - Raw activity items from GET issues/{id}/activities
 * @param statusOrder - Ordered list of statuses from widget config
 * @param issueCreatedAt - Issue creation timestamp (used as start time if no initial state change found)
 * @returns Array of StatusSegment objects in statusOrder order
 */
export function parseStateSegments(
  issueId: string,
  activities: IssueActivityItem[],
  statusOrder: StatusOrderItem[],
  issueCreatedAt: number
): StatusSegment[] {
  // Filter to state-change activities only — multi-method, language-independent
  const stateChanges = filterStateActivities(activities);

  if (stateChanges.length === 0) {
    return [];
  }

  // Build a timeline of (timestamp, stateName) pairs
  // Each entry means "entered this state at this timestamp"
  const timeline: Array<{ timestamp: number; stateName: string; stateId: string }> = [];

  for (const activity of stateChanges) {
    const removedVals = toActivityValueArray(activity.removed);
    const addedVals = toActivityValueArray(activity.added);

    const fromStateName = removedVals[0]?.name ?? removedVals[0]?.presentation ?? '';
    const toStateName = addedVals[0]?.name ?? addedVals[0]?.presentation ?? '';
    const toStateId = addedVals[0]?.id ?? '';

    // First transition: record the "from" state starting at issue creation
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

  if (timeline.length === 0) return [];

  // Build a map of statusName → color from statusOrder
  const statusColorMap = new Map<string, string | undefined>();
  const statusIdColorMap = new Map<string, string | undefined>();
  for (const s of statusOrder) {
    statusColorMap.set(s.name.toLowerCase(), s.color);
    statusIdColorMap.set(s.id, s.color);
  }

  // Determine which statuses to include
  const statusOrderNames = new Set(statusOrder.map((s) => s.name.toLowerCase()));
  const statusOrderIds = new Set(statusOrder.map((s) => s.id));
  const filterByStatusOrder = statusOrder.length > 0;

  // Accumulate duration per status name
  const durationByStatus = new Map<string, { id: string; durationMs: number; color?: string }>();
  const now = Date.now();

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const nextTimestamp = i < timeline.length - 1 ? timeline[i + 1].timestamp : now;
    const durationMs = nextTimestamp - entry.timestamp;

    const nameKey = entry.stateName.toLowerCase();
    const included = filterByStatusOrder
      ? statusOrderNames.has(nameKey) || statusOrderIds.has(entry.stateId)
      : true;

    if (!included || durationMs <= 0) continue;

    const color =
      statusIdColorMap.get(entry.stateId) ?? statusColorMap.get(nameKey);

    const existing = durationByStatus.get(entry.stateName);
    if (existing) {
      existing.durationMs += durationMs;
    } else {
      durationByStatus.set(entry.stateName, {
        id: entry.stateId,
        durationMs,
        color,
      });
    }
  }

  // Build segments in statusOrder order (or natural order if no statusOrder)
  if (filterByStatusOrder) {
    const segments: StatusSegment[] = [];
    for (const orderItem of statusOrder) {
      // Match by name (case-insensitive) or by id
      let entry: { id: string; durationMs: number; color?: string } | undefined;
      for (const [name, val] of durationByStatus.entries()) {
        if (
          name.toLowerCase() === orderItem.name.toLowerCase() ||
          val.id === orderItem.id
        ) {
          entry = val;
          break;
        }
      }
      if (entry && entry.durationMs > 0) {
        segments.push({
          statusName: orderItem.name,
          statusId: orderItem.id,
          durationDays: msToDays(entry.durationMs),
          color: entry.color ?? orderItem.color,
        });
      } else {
        // Status in order but issue never visited it — add zero-duration segment
        segments.push({
          statusName: orderItem.name,
          statusId: orderItem.id,
          durationDays: 0,
          color: orderItem.color,
        });
      }
    }
    return segments;
  } else {
    return Array.from(durationByStatus.entries()).map(([name, val]) => ({
      statusName: name,
      statusId: val.id,
      durationDays: msToDays(val.durationMs),
      color: val.color,
    }));
  }
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

  // Match by id OR by name — NOT id-only-when-both-present. On a dashboard
  // whose search spans multiple projects, the same-named state (e.g. "Dev
  // of Arch") can have a DIFFERENT bundle element id per project, since
  // state fields are typically configured per-project rather than shared.
  // An id-exclusive comparison would then silently fail to match for every
  // project except whichever one statusOrder[0].id happened to be sourced
  // from in the configuration UI, falling back to issueCreatedAt for all
  // the others. Name is the more reliable cross-project signal here, since
  // that's what the user actually picked in the Status Order config.
  const entry = timeline.find((e) =>
    (e.stateId && startStatus.id && e.stateId === startStatus.id) ||
    e.stateName.toLowerCase() === startStatus.name.toLowerCase()
  );
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
  const segments = parseStateSegments(
    issue.id,
    activities,
    statusOrder,
    issueCreatedAt
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