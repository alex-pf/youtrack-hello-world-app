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

/**
 * Extracts a display string from a single activity value entry, tolerating
 * the entry being a RAW PRIMITIVE (string) rather than an ActivityValue
 * object. This matters for single-line text custom fields (e.g. "Reason for
 * blocking"): unlike enum/state-bundle fields, YouTrack's activity API
 * typically represents a plain text field's added/removed value as a bare
 * string, not `{ name, presentation, ... }` — same class of surprise as the
 * DateIssueCustomField-is-a-primitive lesson learned earlier for
 * extractCurrentEstimatedDate(). Falls back to id/name/presentation/value
 * for object-shaped entries (enum fields etc).
 */
function extractActivityValueText(val: ActivityValue | undefined): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return val.name ?? val.presentation ?? (val.value !== undefined ? String(val.value) : '');
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

// ─── Blocking period indicators ─────────────────────────────────────────────
//
// YouTrack has no single universal "blocked" field — different projects may
// model it differently. This is a HEURISTIC, UNTESTED against real project
// data (same situation as the Estimated Date field before its live-data
// debug pass): we look for *any* custom field whose name matches
// /blocked|блокирован/i and treat its activity history as on/off blocking
// transitions, plus a second field matching /reason|причина|blocker/i for
// the blocking reason text. If a real project uses different field names,
// this will detect nothing — the debug panel (see getDebugBlockingInfo)
// surfaces exactly what was/wasn't found so this can be fixed against real
// data.

const BLOCKED_FIELD_NAME_RE = /blocked|блокирован/i;
const REASON_FIELD_NAME_RE = /reason|причина|blocker/i;
// Interpretation of "added value means blocked=true": the value's name or
// presentation starts with an affirmative token (yes/true/да/блокирован...).
// This covers a state-bundle-style field with an explicit "Yes"/"Да" value.
// Confirmed against a real "Blocked?" field: values are "Blocked" (blocked),
// "Need for discuss" and "Muving" (both not-blocked) — an enum/state-bundle
// field, not a boolean checkbox. Only a value literally starting with
// "Blocked"/"Заблокирован" counts as blocked=true; any other enum value
// (including ones we haven't seen) is treated as not-blocked.
const BLOCKED_TRUE_VALUE_RE = /^(yes|true|да|blocked|блокирован)/i;

export interface BlockedTransition {
  timestamp: number;
  isBlocked: boolean;
}

export interface ReasonChange {
  timestamp: number;
  reasonText: string;
}

export interface BlockedInterval {
  start: number;
  end: number | null;
}

export interface ReasonSubPeriod {
  reasonText: string;
  since: number;
}

/**
 * Finds the first activity's `field.name` matching the given regex, i.e. the
 * raw custom-field name as returned by the API. Used both to walk that
 * field's activity history and to surface "which field did we pick" in the
 * debug panel.
 */
function findFieldName(activities: IssueActivityItem[], re: RegExp): string | null {
  for (const a of activities) {
    const name = a.field?.name;
    if (name && re.test(name)) return name;
  }
  return null;
}

/**
 * Interprets whether an activity's `added` value represents "blocked=true".
 * Two heuristics, either sufficient:
 *   1. The added value's name/presentation matches an affirmative token
 *      (yes/true/да/блокирован...) — covers an explicit enum/state value.
 *   2. Simple checkbox-style field: added is non-empty/non-null AND removed
 *      was empty/null (i.e. the field just got a value where it had none) —
 *      covers a boolean-ish field with no clear "Yes" label.
 * Both are guesses; see the module doc comment above.
 */
function isBlockedTrueActivity(activity: IssueActivityItem): boolean {
  const addedVals = toActivityValueArray(activity.added);
  const addedFirst = addedVals[0];
  if (!addedFirst) return false;

  const label = addedFirst.name ?? addedFirst.presentation ?? '';
  if (label) {
    // Enum/state-bundle field with a real label (e.g. "Blocked?"'s three
    // values): match against the affirmative-token regex exactly, no
    // fallback — this is reliable once the field's label is present, and
    // avoids misclassifying a first-ever change to a non-blocking value
    // (e.g. unset -> "Need for discuss") as blocked=true.
    return BLOCKED_TRUE_VALUE_RE.test(label);
  }

  // No label at all (neither name nor presentation) — fall back to a
  // checkbox-style heuristic: added got a value where removed had none.
  const removedVals = toActivityValueArray(activity.removed);
  const addedIsEmpty = addedVals.length === 0 || (!addedFirst.name && !addedFirst.presentation && addedFirst.value === undefined);
  const removedIsEmpty = removedVals.length === 0 || (!removedVals[0]?.name && !removedVals[0]?.presentation && removedVals[0]?.value === undefined);
  return !addedIsEmpty && removedIsEmpty;
}

/**
 * Walks activities for the detected "blocked-like" field and builds a
 * chronological list of on/off transitions.
 */
export function parseBlockedTransitions(
  activities: IssueActivityItem[],
  blockedFieldName: string
): BlockedTransition[] {
  return activities
    .filter((a) => a.field?.name === blockedFieldName)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((a) => ({
      timestamp: a.timestamp,
      isBlocked: isBlockedTrueActivity(a),
    }));
}

/**
 * Walks activities for the detected "reason-like" field and builds a
 * chronological list of reason-text changes.
 */
export function parseReasonChanges(
  activities: IssueActivityItem[],
  reasonFieldName: string
): ReasonChange[] {
  return activities
    .filter((a) => a.field?.name === reasonFieldName)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((a) => {
      const addedVals = toActivityValueArray(a.added);
      const reasonText = extractActivityValueText(addedVals[0]);
      return { timestamp: a.timestamp, reasonText };
    });
}

/**
 * Builds blocking INTERVALS from a chronological transition list. Consecutive
 * on/off/on cycles (even on the same calendar day) always produce SEPARATE
 * intervals — each `true` transition opens a new interval, each `false`
 * transition closes the currently-open one. If the transition list ends
 * while still blocked, the interval's `end` is `stillBlockedEnd` (issue's
 * resolved timestamp, or now).
 */
export function buildBlockedIntervals(
  transitions: BlockedTransition[],
  stillBlockedEnd: number
): BlockedInterval[] {
  const intervals: BlockedInterval[] = [];
  let openStart: number | null = null;

  for (const t of transitions) {
    if (t.isBlocked) {
      // A new "blocked" transition while one is already open is treated as
      // a no-op (stay in the same open interval) rather than opening a
      // duplicate — defensive against redundant activity entries.
      if (openStart === null) {
        openStart = t.timestamp;
      }
    } else if (openStart !== null) {
      intervals.push({ start: openStart, end: t.timestamp });
      openStart = null;
    }
  }

  if (openStart !== null) {
    intervals.push({ start: openStart, end: stillBlockedEnd });
  }

  return intervals;
}

/**
 * For one blocked interval, builds the list of reason sub-periods active
 * during it: the reason in effect AT interval.start (which may come from a
 * reason-change that happened BEFORE blocking began but is still the most
 * recent one), plus every reason-change that falls strictly within
 * [interval.start, interval.end].
 */
export function buildReasonSubPeriods(
  interval: BlockedInterval,
  reasonChanges: ReasonChange[]
): ReasonSubPeriod[] {
  const intervalEnd = interval.end ?? Infinity;
  const subPeriods: ReasonSubPeriod[] = [];

  // Reason active at interval start: the latest reason-change at or before
  // interval.start.
  let activeAtStart: ReasonChange | null = null;
  for (const rc of reasonChanges) {
    if (rc.timestamp <= interval.start) {
      if (!activeAtStart || rc.timestamp > activeAtStart.timestamp) activeAtStart = rc;
    }
  }
  if (activeAtStart) {
    subPeriods.push({ reasonText: activeAtStart.reasonText, since: interval.start });
  }

  // Reason changes strictly within the interval.
  for (const rc of reasonChanges) {
    if (rc.timestamp > interval.start && rc.timestamp <= intervalEnd) {
      subPeriods.push({ reasonText: rc.reasonText, since: rc.timestamp });
    }
  }

  return subPeriods;
}

function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

/**
 * Groups intervals into chains where one interval's end and the next
 * interval's start fall on the SAME calendar day (e.g. blocking was lifted
 * and reapplied later the same day). Each group's tooltip shows every
 * member interval's own date range plus their combined duration/reasons —
 * per product spec: "с <date> по <date> / с <date> по <date> (если конец
 * одной блокировки и начало другой в один день)".
 */
function groupAdjacentSameDayIntervals(intervals: BlockedInterval[]): BlockedInterval[][] {
  const groups: BlockedInterval[][] = [];
  let current: BlockedInterval[] = [];

  for (const interval of intervals) {
    const prev = current[current.length - 1];
    const sameDayAsPrev = prev?.end !== null && prev?.end !== undefined
      && toDateString(prev.end) === toDateString(interval.start);
    if (current.length === 0 || sameDayAsPrev) {
      current.push(interval);
    } else {
      groups.push(current);
      current = [interval];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups;
}

/**
 * Builds one 'hatch' ChartIndicator per blocked interval for an issue (so
 * each interval renders as its own visually distinct hatched rect), detecting
 * the blocked/reason fields by name heuristic (see module doc comment).
 * Intervals whose boundary shares a calendar day with a neighbor are grouped
 * so their tooltips show BOTH ranges together (see
 * groupAdjacentSameDayIntervals) — every indicator in a group shares the
 * same tooltip content.
 *
 * Tooltip format (per product spec):
 *   Блокировка
 *   с <date> по <date>            [one line per interval in the group]
 *   продолжительность: <N> дней   [sum across the group's intervals]
 *   Причина блокировки:
 *   <reason 1>                    [distinct reasons across the group, in
 *   <reason 2>                     chronological order]
 *
 * Returns [] if no blocked-like field was found at all, or if the field was
 * found but produced zero completed/open intervals.
 */
export function buildBlockingIndicators(
  issueId: string,
  activities: IssueActivityItem[],
  issueResolvedAt: number | null
): ChartIndicator[] {
  const blockedFieldName = findFieldName(activities, BLOCKED_FIELD_NAME_RE);
  if (!blockedFieldName) return [];

  const reasonFieldName = findFieldName(activities, REASON_FIELD_NAME_RE);

  const transitions = parseBlockedTransitions(activities, blockedFieldName);
  const stillBlockedEnd = issueResolvedAt ?? Date.now();
  const intervals = buildBlockedIntervals(transitions, stillBlockedEnd);
  if (intervals.length === 0) return [];

  const reasonChanges = reasonFieldName ? parseReasonChanges(activities, reasonFieldName) : [];

  const groups = groupAdjacentSameDayIntervals(intervals);
  const indicators: ChartIndicator[] = [];

  for (const group of groups) {
    // Date-range lines: one per interval in the group.
    const rangeLines = group.map((interval) => ({
      label: '',
      value: `с ${formatDateShort(interval.start)} по ${formatDateShort(interval.end ?? stillBlockedEnd)}`,
    }));

    // Combined duration across the group's intervals, in whole days.
    const totalDurationMs = group.reduce(
      (sum, interval) => sum + ((interval.end ?? stillBlockedEnd) - interval.start),
      0
    );
    const durationDays = Math.max(1, Math.round(totalDurationMs / DAY_MS));

    // Distinct reasons across all of the group's intervals, chronological,
    // deduplicated (a reason that persists across the group's boundary
    // shouldn't be listed twice).
    const seenReasons = new Set<string>();
    const reasonLines: { label: string; value: string }[] = [];
    for (const interval of group) {
      for (const sp of buildReasonSubPeriods(interval, reasonChanges)) {
        const text = sp.reasonText || 'Причина не указана';
        if (seenReasons.has(text)) continue;
        seenReasons.add(text);
        reasonLines.push({ label: '', value: text });
      }
    }
    if (reasonLines.length === 0) {
      reasonLines.push({ label: '', value: 'Причина не указана' });
    }

    const tooltipRows: { label: string; value: string }[] = [
      ...rangeLines,
      { label: 'продолжительность', value: `${durationDays} дн.` },
      { label: '', value: 'Причина блокировки:' },
      ...reasonLines,
    ];

    for (const interval of group) {
      indicators.push({
        kind: 'hatch',
        semanticType: 'blocking',
        id: `${issueId}-blocking-${interval.start}`,
        rangeStart: interval.start,
        rangeEnd: interval.end ?? stillBlockedEnd,
        tooltipTitle: 'Блокировка',
        tooltipRows,
        color: '#F44336',
      });
    }
  }

  return indicators;
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
    const blockingIndicators = buildBlockingIndicators(issue.id, activities, issue.resolved);

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
      indicators: [
        ...estimateDateIndicators,
        ...(currentEstimateFlag ? [currentEstimateFlag] : []),
        ...blockingIndicators,
      ],
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

/**
 * Exposes the raw blocked/reason field detection results + derived intervals
 * for one issue, for the widget's debug-mode UI. This is the troubleshooting
 * hook for the blocked/reason field-name heuristic in
 * buildBlockingIndicators() — since that heuristic is UNTESTED against real
 * YouTrack project data, this lets a user with debugMode on see exactly
 * which field (if any) was detected and what intervals/reasons were derived
 * from it, so mismatches can be reported and the regexes adjusted. Mirrors
 * the pattern used for the Estimated Date raw-field debug output in app.tsx.
 */
export function getDebugBlockingInfo(
  activities: IssueActivityItem[],
  issueResolvedAt: number | null
): {
  blockedFieldName: string | null;
  reasonFieldName: string | null;
  transitions: BlockedTransition[];
  intervals: BlockedInterval[];
  reasonChanges: ReasonChange[];
  subPeriodsByInterval: ReasonSubPeriod[][];
} {
  const blockedFieldName = findFieldName(activities, BLOCKED_FIELD_NAME_RE);
  const reasonFieldName = findFieldName(activities, REASON_FIELD_NAME_RE);

  const transitions = blockedFieldName ? parseBlockedTransitions(activities, blockedFieldName) : [];
  const stillBlockedEnd = issueResolvedAt ?? Date.now();
  const intervals = blockedFieldName ? buildBlockedIntervals(transitions, stillBlockedEnd) : [];
  const reasonChanges = reasonFieldName ? parseReasonChanges(activities, reasonFieldName) : [];
  const subPeriodsByInterval = intervals.map((interval) => buildReasonSubPeriods(interval, reasonChanges));

  return {
    blockedFieldName,
    reasonFieldName,
    transitions,
    intervals,
    reasonChanges,
    subPeriodsByInterval,
  };
}
