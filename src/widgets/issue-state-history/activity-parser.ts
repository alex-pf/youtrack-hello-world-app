import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  StatusOrderItem,
  DateSegment,
  IssueStateHistoryData,
  ChartIndicator,
} from './types';
import { extractCurrentState, extractCurrentEstimatedDate } from './resources';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Short readable date format matching the "%d %b" style used by
// gantt-chart.tsx's axis tickFormat (e.g. "25 Jun").
const shortDateFormatter = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });
function formatShortDate(ts: number): string {
  return shortDateFormatter.format(new Date(ts));
}

function toActivityValueArray(val: ActivityValue[] | ActivityValue | null): ActivityValue[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function toDateString(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatDateOrUnset(ts: number | null): string {
  if (ts === null) return 'не задано';
  return new Date(ts).toLocaleDateString();
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

// ─── Estimate Date change indicators ────────────────────────────────────────

export interface EstimateDateChangeEvent {
  changedAt: number;
  fromDate: number | null;
  toDate: number | null;
}

/**
 * Walks an issue's raw activity list and detects changes to the "Estimated
 * Date" custom field. Mirrors the detection logic in
 * issues-progress/activity-parser.ts (parseEstimateDateChanges): match by
 * field name (language-independent substring match on common English field
 * names), parse added/removed ActivityValue.value as a Unix ms timestamp
 * (may arrive as a number or a numeric string from the API).
 *
 * Same-day deduplication: if multiple changes happen on the same calendar
 * day, only the LAST one (highest timestamp) is kept — consistent with
 * issues-progress, and it keeps the chart from cluttering a single day with
 * redundant markers for rapid successive edits.
 *
 * @param activities - Raw activity items for one issue (unfiltered)
 * @returns Change events sorted chronologically, one per unique day
 */
export function parseEstimateDateChanges(
  activities: IssueActivityItem[]
): EstimateDateChangeEvent[] {
  const dateChanges = activities
    .filter((a) => {
      const fieldName = a.field?.name?.toLowerCase() ?? '';
      return (
        fieldName.includes('estimated') ||
        fieldName.includes('due date') ||
        fieldName.includes('deadline')
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

  const parseDate = (vals: ActivityValue[]): number | null => {
    if (vals.length === 0) return null;
    const val = vals[0];

    // PRIMARY: accept both number and string representation of Unix ms timestamp
    if (val.value !== undefined && val.value !== null) {
      const ts = Number(val.value);
      if (!isNaN(ts) && ts > 0) return ts;
    }

    // FALLBACK 1: val.id as numeric timestamp or ISO date string
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

  const result: EstimateDateChangeEvent[] = [];
  for (const activity of byDay.values()) {
    const removedVals = toActivityValueArray(activity.removed);
    const addedVals = toActivityValueArray(activity.added);
    result.push({
      changedAt: activity.timestamp,
      fromDate: parseDate(removedVals),
      toDate: parseDate(addedVals),
    });
  }

  result.sort((a, b) => a.changedAt - b.changedAt);
  return result;
}

/**
 * Builds 'marker' ChartIndicators for an issue's Estimated Date field
 * changes. Per product spec, these markers carry NO inline chart label (only
 * a tooltip) — the marker's date is the moment the field was CHANGED, not
 * the estimated date value itself.
 *
 * semanticType is set to 'estimate-date-change' so the UI toggle panel can
 * show/hide this specific indicator type independently of any other
 * 'marker'-kind indicator that a future task might add.
 */
export function buildEstimateDateChangeIndicators(
  issueId: string,
  activities: IssueActivityItem[]
): ChartIndicator[] {
  const changes = parseEstimateDateChanges(activities);
  return changes.map((change, idx) => ({
    kind: 'marker',
    semanticType: 'estimate-date-change',
    id: `${issueId}-estimate-change-${idx}-${change.changedAt}`,
    date: change.changedAt,
    tooltipTitle: 'Изменение Estimated Date',
    tooltipRows: [
      { label: 'Было', value: formatDateOrUnset(change.fromDate) },
      { label: 'Стало', value: formatDateOrUnset(change.toDate) },
    ],
  }));
}

/**
 * Builds a single 'flag' ChartIndicator marking an issue's CURRENT Estimated
 * Date value (as opposed to buildEstimateDateChangeIndicators, which marks
 * every point in time the field was CHANGED). Per product spec: "Изобразим
 * его флажком. Подпись: <date>, LT<лид тайм к этой дате>" — a flag glyph at
 * the current Estimated Date, labeled with the date and the lead time (in
 * days, or weeks past 28 days) from the issue's start to that date.
 *
 * Returns null when the issue has no current Estimated Date value at all
 * (never set) — per product spec, no flag should be rendered in that case.
 *
 * Label format: `${dateStr}, LT-${ltStr}` — e.g. "25 Jun, LT-45d" or
 * "25 Jun, LT-6w". Note the order is date-first-then-LT here, which is the
 * REVERSE of issues-progress's "LT-{ltStr}; {dateStr}" precedent — this is
 * intentional per the product spec's explicit wording ("<date>, LT...").
 * The day/week rounding convention (>28 days => weeks) is reused as-is from
 * issues-progress/gantt-chart.tsx's showProjectedLT block.
 *
 * Edge case: if leadTimeDays <= 0 (the estimated date is before the issue
 * even started — e.g. a stale estimate on an issue whose start status was
 * re-entered later), the flag still renders but the label omits the LT
 * part entirely (just the date), since a negative/zero lead time isn't a
 * meaningful number to show inline. The tooltip's Lead Time row still shows
 * the raw (possibly negative) day count for full transparency.
 */
export function buildCurrentEstimateFlagIndicator(
  issue: Issue,
  overallStart: number,
  currentEstimateDate: number | null
): ChartIndicator | null {
  if (currentEstimateDate === null) return null;

  const dateStr = formatShortDate(currentEstimateDate);
  const leadTimeDays = (currentEstimateDate - overallStart) / DAY_MS;

  let label: string;
  if (leadTimeDays > 0) {
    const ltStr = leadTimeDays > 28
      ? `${Math.round(leadTimeDays / 7)}w`
      : `${Math.round(leadTimeDays)}d`;
    label = `${dateStr}, LT-${ltStr}`;
  } else {
    label = dateStr;
  }

  return {
    kind: 'flag',
    semanticType: 'estimate-date-current',
    id: `${issue.id}-estimate-current`,
    date: currentEstimateDate,
    label,
    tooltipTitle: 'Текущий Estimated Date',
    tooltipRows: [
      { label: 'Дата', value: dateStr },
      { label: 'Lead Time', value: `${Math.round(leadTimeDays)} дн.` },
    ],
  };
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

    const estimateDateIndicators = buildEstimateDateChangeIndicators(issue.id, activities);

    const overallStart = segments[0].startDate;
    const currentEstimateDate = extractCurrentEstimatedDate(issue);
    const currentEstimateFlag = buildCurrentEstimateFlagIndicator(
      issue,
      overallStart,
      currentEstimateDate
    );

    result.push({
      issueId: issue.id,
      idReadable: issue.idReadable,
      summary: issue.summary,
      segments,
      overallStart,
      overallEnd: segments[segments.length - 1].endDate,
      neverReachedStartStatus,
      // Built as a fresh array from each producer's output, appended together —
      // Task 4 producers should follow the same pattern (compute their own
      // indicator array, then spread it in here) rather than overwriting.
      indicators: [...estimateDateIndicators, ...(currentEstimateFlag ? [currentEstimateFlag] : [])],
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
