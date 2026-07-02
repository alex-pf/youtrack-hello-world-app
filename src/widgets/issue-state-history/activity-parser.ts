import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  StatusOrderItem,
  DateSegment,
  IssueStateHistoryData,
} from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toActivityValueArray(val: ActivityValue[] | ActivityValue | null): ActivityValue[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/**
 * Filters and sorts activity items to only state-field-change events.
 * Adapted from issues-progress/activity-parser.ts filterStateActivities().
 */
function filterStateActivities(activities: IssueActivityItem[]): IssueActivityItem[] {
  return activities
    .filter((a) => {
      // Method 1: Check $type on added/removed values — language-independent
      const addedArr = toActivityValueArray(a.added);
      const removedArr = toActivityValueArray(a.removed);
      const allVals = [...addedArr, ...removedArr];
      if (allVals.some((v) => v.$type?.toLowerCase().includes('state'))) return true;

      // Method 2: Check field name — covers English and common localizations
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

// ─── Raw transition timeline (internal) ───────────────────────────────────────

interface TransitionEntry {
  timestamp: number;
  stateName: string;
  stateId: string;
}

/**
 * Walks the filtered, chronologically-sorted state-change activities and
 * builds the raw sequence of "entered this state at this timestamp" entries.
 * Mirrors parseStateTimeline() in issues-progress/activity-parser.ts.
 *
 * The first entry (the state the issue was created into) is recovered from
 * the `removed` value of the first state-change activity, timestamped at
 * `issueCreatedAt`. If there are no state-change activities at all, the
 * issue never changed state — no timeline can be built.
 */
function buildTransitionTimeline(
  activities: IssueActivityItem[],
  issueCreatedAt: number
): TransitionEntry[] {
  const stateChanges = filterStateActivities(activities);
  if (stateChanges.length === 0) return [];

  const timeline: TransitionEntry[] = [];

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

// ─── Date-based segment builder ────────────────────────────────────────────────

/**
 * Builds absolute-calendar-date segments for a single issue's state history.
 *
 * Behavior:
 * - Walks the same chronological transition timeline as issues-progress
 *   (see buildTransitionTimeline / filterStateActivities above).
 * - Every state the issue passed through produces a segment, whether or not
 *   it's in `statusOrder`. Statuses not found in `statusOrder` are tagged
 *   `isUnconfigured: true` / `statusId: null` so the chart can render them
 *   as gray bars instead of dropping them (per product requirement).
 * - The returned array is TRIMMED to start at the first segment whose status
 *   matches `statusOrder[0]` (the configured "start" status). Any segments
 *   before the issue first entered the start status are discarded — the
 *   chart's date axis begins at the start status, not at issue creation.
 *   EXCEPTION: if the issue's very first recorded state IS statusOrder[0],
 *   that segment's startDate is issueCreatedAt (nothing to trim).
 * - If the issue NEVER enters statusOrder[0] (e.g. it skipped straight from
 *   "Open" to "Done" and "Open" isn't the start status, or it never left an
 *   initial unconfigured state), this function returns an EMPTY array. The
 *   caller (buildIssueStateHistoryData) excludes such issues from the chart
 *   entirely — see its docstring for rationale.
 * - The LAST segment's endDate is `issueResolvedAt` when the issue is
 *   resolved/closed, otherwise `Date.now()` (the issue is still open and its
 *   current status is ongoing "as of now").
 *
 * @param activities - Raw activity items for one issue (unfiltered)
 * @param issueCreatedAt - Unix ms timestamp the issue was created
 * @param issueResolvedAt - Unix ms timestamp the issue was resolved, or null if still open
 * @param statusOrder - Ordered list of configured statuses; statusOrder[0] is the "start" status
 * @returns Chronological array of DateSegment, or [] if the issue never entered the start status
 */
export function buildDateSegments(
  activities: IssueActivityItem[],
  issueCreatedAt: number,
  issueResolvedAt: number | null,
  statusOrder: StatusOrderItem[]
): DateSegment[] {
  if (statusOrder.length === 0) return [];
  const startStatus = statusOrder[0];

  const timeline = buildTransitionTimeline(activities, issueCreatedAt);
  if (timeline.length === 0) return [];

  // Map for quick "is this state configured" lookups (case-insensitive name, or id match)
  const configuredByName = new Map<string, StatusOrderItem>();
  const configuredById = new Map<string, StatusOrderItem>();
  for (const s of statusOrder) {
    configuredByName.set(s.name.toLowerCase(), s);
    configuredById.set(s.id, s);
  }

  function resolveConfigured(stateName: string, stateId: string): StatusOrderItem | undefined {
    return (stateId ? configuredById.get(stateId) : undefined) ?? configuredByName.get(stateName.toLowerCase());
  }

  const isStartStatus = (stateName: string, stateId: string): boolean => {
    if (stateId && startStatus.id) return stateId === startStatus.id;
    return stateName.toLowerCase() === startStatus.name.toLowerCase();
  };

  // Build the full segment list (end date of each = start of next; last = now/resolved)
  const nowOrResolved = issueResolvedAt ?? Date.now();
  const allSegments: DateSegment[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const endDate = i < timeline.length - 1 ? timeline[i + 1].timestamp : nowOrResolved;

    // Skip degenerate zero/negative-length segments (e.g. duplicate activity timestamps)
    if (endDate <= entry.timestamp) continue;

    const configured = resolveConfigured(entry.stateName, entry.stateId);
    allSegments.push({
      statusId: configured ? configured.id : null,
      statusName: entry.stateName,
      startDate: entry.timestamp,
      endDate,
      isUnconfigured: !configured,
    });
  }

  // Trim to start at the first segment matching the configured start status.
  const startIndex = allSegments.findIndex((seg) =>
    isStartStatus(seg.statusName, seg.statusId ?? '')
  );

  if (startIndex === -1) {
    // Issue never entered the configured start status — exclude from chart.
    return [];
  }

  return allSegments.slice(startIndex);
}

// ─── Main aggregator ───────────────────────────────────────────────────────────

/**
 * Combines issues with their activity history into date-segmented chart data.
 *
 * Issues that never entered the configured start status (statusOrder[0]) are
 * excluded from the result entirely — buildDateSegments() returns [] for
 * them, and there's nothing meaningful to plot on a calendar-date axis
 * without a defined starting point.
 *
 * @param issues - Issues from loadIssues()
 * @param activitiesMap - Map of issueId -> raw activities from loadActivitiesBatch()
 * @param statusOrder - Ordered statuses from widget config; statusOrder[0] is the "start" status
 * @returns Array of IssueStateHistoryData, one per included issue
 */
export function buildIssueStateHistoryData(
  issues: Issue[],
  activitiesMap: Map<string, IssueActivityItem[]>,
  statusOrder: StatusOrderItem[]
): IssueStateHistoryData[] {
  const result: IssueStateHistoryData[] = [];

  for (const issue of issues) {
    const activities = activitiesMap.get(issue.id) ?? [];
    const segments = buildDateSegments(
      activities,
      issue.created ?? Date.now(),
      issue.resolved,
      statusOrder
    );

    if (segments.length === 0) {
      // Issue never entered the configured start status — exclude from chart.
      continue;
    }

    result.push({
      issueId: issue.id,
      idReadable: issue.idReadable,
      summary: issue.summary,
      segments,
      overallStart: segments[0].startDate,
      overallEnd: segments[segments.length - 1].endDate,
    });
  }

  return result;
}
