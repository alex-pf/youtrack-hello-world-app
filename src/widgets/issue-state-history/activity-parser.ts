import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  StatusOrderItem,
  DateSegment,
  IssueStateHistoryData,
} from './types';
import { extractCurrentState } from './resources';

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
 * Result of buildDateSegments(): the segments plus whether the issue ever
 * reached the configured start status.
 */
export interface DateSegmentsResult {
  segments: DateSegment[];
  // True when the issue never entered statusOrder[0] and segments therefore
  // start from issue creation instead of the start-status entry time.
  neverReachedStartStatus: boolean;
}

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
 * - If the issue's history includes a segment matching `statusOrder[0]`
 *   (the configured "start" status), the returned array is TRIMMED to start
 *   there — segments before the issue first entered the start status are
 *   discarded, so the chart's date axis begins at the start status.
 *   EXCEPTION: if the issue's very first recorded state IS statusOrder[0],
 *   that segment's startDate is issueCreatedAt (nothing to trim).
 * - If the issue NEVER enters statusOrder[0] (e.g. it skipped straight from
 *   "Open" to "Done" and "Open" isn't the start status, or `statusOrder` is
 *   empty/unconfigured), NO segments are dropped. Per product requirement
 *   ("if an issue matches the search query, it must be visible on the
 *   chart"), the full timeline starting at issue creation is returned
 *   instead, and `neverReachedStartStatus` is set to true so callers can
 *   flag these issues distinctly (e.g. a tooltip note or legend marker).
 * - The LAST segment's endDate is `issueResolvedAt` when the issue is
 *   resolved/closed, otherwise `Date.now()` (the issue is still open and its
 *   current status is ongoing "as of now").
 *
 * @param activities - Raw activity items for one issue (unfiltered)
 * @param issueCreatedAt - Unix ms timestamp the issue was created
 * @param issueResolvedAt - Unix ms timestamp the issue was resolved, or null if still open
 * @param statusOrder - Ordered list of configured statuses; statusOrder[0] is the "start" status (may be empty if unconfigured)
 * @param currentState - The issue's current State field value, used as a
 *   fallback single segment (creation → now/resolved) when the issue has NO
 *   state-change activity at all (e.g. it has never left its initial default
 *   status — YouTrack does not log that as a "change"). Without this, such
 *   issues would have an empty timeline and be excluded, violating the
 *   requirement that every matched issue must be visible on the chart.
 * @returns { segments, neverReachedStartStatus } — segments is [] only when
 *   the issue has no usable transition/creation timeline AND no current
 *   state value at all
 */
export function buildDateSegments(
  activities: IssueActivityItem[],
  issueCreatedAt: number,
  issueResolvedAt: number | null,
  statusOrder: StatusOrderItem[],
  currentState?: { id: string; name: string }
): DateSegmentsResult {
  let timeline = buildTransitionTimeline(activities, issueCreatedAt);

  // Fallback: no state-change activity at all — the issue has been sitting
  // in one status since creation. Synthesize a single-entry timeline from
  // its current State field value so it still gets a visible segment.
  if (timeline.length === 0 && currentState) {
    timeline = [{ timestamp: issueCreatedAt, stateName: currentState.name, stateId: currentState.id }];
  }

  if (timeline.length === 0) return { segments: [], neverReachedStartStatus: statusOrder.length > 0 };

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

  // statusOrder may be empty if the user hasn't configured statuses yet —
  // in that case there is no start status to match against, so nothing is
  // trimmed and every issue is treated as "never reached start status".
  const startStatus = statusOrder.length > 0 ? statusOrder[0] : null;

  const isStartStatus = (stateName: string, stateId: string): boolean => {
    if (!startStatus) return false;
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
    // Issue never entered the configured start status (or none is
    // configured) — keep the full timeline from creation, but flag it.
    return { segments: allSegments, neverReachedStartStatus: true };
  }

  return { segments: allSegments.slice(startIndex), neverReachedStartStatus: false };
}

// ─── Main aggregator ───────────────────────────────────────────────────────────

/**
 * Combines issues with their activity history into date-segmented chart data.
 *
 * Every issue passed in is included in the result — per product requirement,
 * an issue that matches the search query must be visible on the chart even
 * if it never entered the configured start status (statusOrder[0]). In that
 * case buildDateSegments() falls back to the full timeline from issue
 * creation and marks `neverReachedStartStatus: true` on the returned entry.
 *
 * The only issues skipped are ones with literally no usable timeline (no
 * state-change activity AND no creation timestamp) — see the zero-segments
 * guard below.
 *
 * @param issues - Issues from loadIssues()
 * @param activitiesMap - Map of issueId -> raw activities from loadActivitiesBatch()
 * @param statusOrder - Ordered statuses from widget config; statusOrder[0] is the "start" status (may be empty)
 * @returns Array of IssueStateHistoryData, one per issue with a usable timeline
 */
export function buildIssueStateHistoryData(
  issues: Issue[],
  activitiesMap: Map<string, IssueActivityItem[]>,
  statusOrder: StatusOrderItem[]
): IssueStateHistoryData[] {
  const result: IssueStateHistoryData[] = [];

  for (const issue of issues) {
    const activities = activitiesMap.get(issue.id) ?? [];
    const { segments, neverReachedStartStatus } = buildDateSegments(
      activities,
      issue.created ?? Date.now(),
      issue.resolved,
      statusOrder,
      extractCurrentState(issue)
    );

    if (segments.length === 0) {
      // No usable timeline at all — no state-change activity AND no current
      // State field value could be read either (extremely rare: a project
      // without a State-type field, or a malformed response). Skip rather
      // than render a broken zero-width row.
      continue;
    }

    result.push({
      issueId: issue.id,
      idReadable: issue.idReadable,
      summary: issue.summary,
      segments,
      overallStart: segments[0].startDate,
      overallEnd: segments[segments.length - 1].endDate,
      neverReachedStartStatus,
    });
  }

  return result;
}

// ─── Debug helper ────────────────────────────────────────────────────────────

/**
 * Exposes the raw parsed transition timeline for one issue, for use by the
 * widget's debug-mode UI (shows timestamp + state name per issue). Thin
 * wrapper around buildTransitionTimeline() — kept minimal since this is
 * debug-only, not a new feature.
 */
export function getDebugTransitionTimeline(
  activities: IssueActivityItem[],
  issueCreatedAt: number
): { timestamp: number; stateName: string }[] {
  return buildTransitionTimeline(activities, issueCreatedAt).map((e) => ({
    timestamp: e.timestamp,
    stateName: e.stateName,
  }));
}
