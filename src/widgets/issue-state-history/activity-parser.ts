import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  StatusOrderItem,
  DateSegment,
  IssueStateHistoryData,
  ChartIndicator,
  IssueLinkActivityItem,
  LinkedIssueRef,
  ChildIssueRef,
  ChildLinkChangeEvent,
  AssigneeRef,
  AssigneeChangeEvent,
} from './types';
import { extractCurrentState, extractCurrentEstimatedDate, extractCurrentAssignees } from './resources';

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

  // Match by id OR by name — NOT id-only-when-both-present. On a dashboard
  // whose search spans multiple projects, the same-named status can have a
  // DIFFERENT bundle element id per project (state fields are typically
  // configured per-project, not shared), so an id-exclusive comparison
  // would silently fail to match for every project except whichever one
  // startStatus.id happened to be sourced from in the configuration UI.
  const isStartStatus = (stateName: string, stateId: string): boolean => {
    if (!startStatus) return false;
    return (
      (!!stateId && !!startStatus.id && stateId === startStatus.id) ||
      stateName.toLowerCase() === startStatus.name.toLowerCase()
    );
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

    // Same primitive-vs-object surprise as DateIssueCustomField's plain
    // field value (see extractCurrentEstimatedDate in resources.ts): the
    // activity's added/removed entry for a date field change may arrive as
    // a bare number/numeric-string rather than an {value,id,presentation}
    // object. Check for that FIRST.
    if (typeof val === 'number') {
      return val > 0 ? val : null;
    }
    if (typeof val === 'string') {
      const asNum = Number(val);
      if (!isNaN(asNum) && asNum > 0) return asNum;
      const asDate = Date.parse(val);
      return isNaN(asDate) ? null : asDate;
    }

    // PRIMARY (object shape): accept both number and string representation of Unix ms timestamp
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

// ─── Child issue link-change indicators ─────────────────────────────────────
//
// Only the "Родитель для" / "Parent for" (link type family "Subtask",
// outward direction — this issue is the parent) direction is considered.
// The reverse direction ("Подзадача для" / "Subtask of", this issue IS a
// child) is ignored completely, as is every other link type (Relates,
// Duplicates, Depends on, Cloned, ...).
//
// CONFIRMED against a live YouTrack instance (2026-07-03) via
// getDebugChildLinkInfo(): category is `LinksCategory`, `$type` is
// `LinksActivityItem`, `added`/`removed` do include `idReadable`/`summary`,
// but `linkType` and the top-level `direction` field are BOTH absent from
// the payload — the only usable signal is `field.name` (e.g. "Родитель
// для" / "Подзадача для"), which is checked first in
// filterChildLinkActivities() below.

const CHILD_LINK_TYPE_NAME_RE = /subtask|подзадач/i;
const CHILD_LINK_PARENT_FOR_RE = /родитель для|parent for/i;
const CHILD_LINK_SUBTASK_OF_RE = /подзадача для|subtask of/i;

function toLinkedIssueRefArray(
  val: LinkedIssueRef[] | LinkedIssueRef | null
): LinkedIssueRef[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function toChildIssueRef(ref: LinkedIssueRef): ChildIssueRef {
  return {
    id: ref.id,
    idReadable: ref.idReadable,
    // Fallback to idReadable when the activity payload doesn't include a
    // summary (see risk notes in types.ts/docs) — better to show the issue
    // number than nothing at all.
    summary: ref.summary ?? ref.idReadable,
  };
}

/**
 * Filters an issue's LinksCategory activities down to ones representing a
 * "Родитель для"/"Subtask" (outward) change — i.e. this issue gained/lost a
 * CHILD. Direction is determined primarily from the `direction` field when
 * present; when absent (not all API versions return it), we fall back to
 * `field.name` — the DIRECTIONAL wording YouTrack attaches to the specific
 * activity (e.g. "Родитель для" when this issue fired the activity as the
 * parent side, "Подзадача для" when it fired as the child side of the very
 * same link type). `linkType.sourceToTarget`/`targetToSource` are NOT usable
 * for this: they're static properties of the link type itself (always
 * "Родитель для" / "Подзадача для" respectively, regardless of which side a
 * given activity happened on), so they can't distinguish direction per
 * activity — only `field.name` (or `direction`) can.
 *
 * CONFIRMED against a live YouTrack instance (2026-07-03): `LinksActivityItem`
 * does NOT populate `linkType` at all — the field selector silently returns
 * nothing for it. The only signal actually present is `field`, typed
 * `LinkTypeFilterField`, whose `name` carries the DIRECTIONAL wording itself
 * (e.g. `"Родитель для"` on the parent side, `"Подзадача для"` on the child
 * side of the same Subtask link). There is also no top-level `direction`
 * field on this activity shape. So `field.name` is both the "is this a
 * Subtask-family link" AND the "which direction" signal — it must be checked
 * FIRST, not gated behind a `linkType` family match that will never be true.
 */
export function filterChildLinkActivities(
  activities: IssueLinkActivityItem[]
): IssueLinkActivityItem[] {
  return activities
    .filter((a) => {
      if (a.category?.id !== 'LinksCategory') return false;

      const fieldName = a.field?.name ?? '';
      if (fieldName) {
        if (CHILD_LINK_SUBTASK_OF_RE.test(fieldName)) return false;
        return CHILD_LINK_PARENT_FOR_RE.test(fieldName);
      }

      // Defensive fallback for API shapes where `field.name` is absent but
      // `linkType`/`direction` metadata is present instead.
      if (a.direction) {
        const typeName = a.linkType?.name ?? '';
        const typeLocalized = a.linkType?.localizedName ?? '';
        const sourceToTarget = a.linkType?.sourceToTarget ?? '';
        const isSubtaskFamily =
          CHILD_LINK_TYPE_NAME_RE.test(typeName) ||
          CHILD_LINK_TYPE_NAME_RE.test(typeLocalized) ||
          CHILD_LINK_PARENT_FOR_RE.test(sourceToTarget);
        return isSubtaskFamily && a.direction === 'OUTWARD';
      }

      return false;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Merges a day's worth of child-link activities into ChildLinkChangeEvent(s)
 * — per-day MERGE (union of all added/removed that day), not "keep only the
 * last change" like parseEstimateDateChanges(), because losing intermediate
 * added/removed entries would make the tooltip's per-day change list wrong.
 *
 * Same child added AND removed on the same day: kept in BOTH addedChildren
 * and removedChildren (two honest facts about the day), but this cancels out
 * in the day's net.
 *
 * net === 0 from an exact add+remove compensation is the ONE case where a
 * single calendar day produces TWO ChildLinkChangeEvent objects instead of
 * one — an add-only event (net = +addedChildren.length) and a remove-only
 * event (net = -removedChildren.length), each carrying only its half of the
 * day's added/removed lists. Rationale: the product spec's color is strictly
 * binary (green = added, yellow = removed) with no third "mixed" color, so
 * splitting into two honest dots is preferred over inventing one ambiguous
 * dot. A day with unequal added/removed (net != 0, e.g. +2/-1) stays ONE
 * event with both lists populated — only the net===0-via-compensation case
 * splits.
 * If net === 0 because there were no activities that day, there is no event
 * at all for that day (nothing to report).
 */
export function parseChildLinkChanges(
  activities: IssueLinkActivityItem[]
): ChildLinkChangeEvent[] {
  const changes = filterChildLinkActivities(activities);
  if (changes.length === 0) return [];

  const byDay = new Map<string, IssueLinkActivityItem[]>();
  for (const activity of changes) {
    const day = toDateString(activity.timestamp);
    const existing = byDay.get(day);
    if (existing) {
      existing.push(activity);
    } else {
      byDay.set(day, [activity]);
    }
  }

  const result: ChildLinkChangeEvent[] = [];

  for (const dayActivities of byDay.values()) {
    const changedAt = dayActivities[dayActivities.length - 1].timestamp;

    const addedById = new Map<string, ChildIssueRef>();
    const removedById = new Map<string, ChildIssueRef>();
    for (const activity of dayActivities) {
      for (const ref of toLinkedIssueRefArray(activity.added)) {
        addedById.set(ref.id, toChildIssueRef(ref));
      }
      for (const ref of toLinkedIssueRefArray(activity.removed)) {
        removedById.set(ref.id, toChildIssueRef(ref));
      }
    }

    const addedChildren = Array.from(addedById.values());
    const removedChildren = Array.from(removedById.values());
    const net = addedChildren.length - removedChildren.length;

    if (net === 0 && addedChildren.length > 0 && removedChildren.length > 0) {
      result.push({
        changedAt,
        addedChildren,
        removedChildren: [],
        net: addedChildren.length,
        childrenAsOfEvent: [],
      });
      result.push({
        changedAt,
        addedChildren: [],
        removedChildren,
        net: -removedChildren.length,
        childrenAsOfEvent: [],
      });
    } else {
      result.push({ changedAt, addedChildren, removedChildren, net, childrenAsOfEvent: [] });
    }
  }

  result.sort((a, b) => a.changedAt - b.changedAt);
  return result;
}

/**
 * Fills in `childrenAsOfEvent` for each change via a BACKWARD pass, starting
 * from the known-correct "now" snapshot (currentChildren, from the
 * issues/{id}/links API add-on) and walking the events from last to first.
 *
 * Why backward, not forward-from-zero: the issue may have had children
 * before LinksCategory activities were included in the fetched history, or
 * before the activitiesPage's own $top=1000 window — counting "up from zero"
 * from the first known activity risks an incorrect baseline (the same class
 * of problem buildTransitionTimeline solves via extractCurrentState
 * fallback). Anchoring on the definitely-correct "now" and rolling backward
 * avoids that risk entirely.
 *
 * For event i (processed last-to-first): childrenAsOfEvent[i] is assigned
 * the CURRENT working set (i.e. the set that holds AFTER event i was
 * applied) BEFORE rolling the working set back to "before event i" for the
 * next (earlier) iteration. Rolling back means: remove ids that were in
 * event i's addedChildren (they didn't exist yet before this event), and add
 * back ids that were in event i's removedChildren (they still existed
 * before this event).
 */
export function buildChildrenTimeline(
  changes: ChildLinkChangeEvent[],
  currentChildren: ChildIssueRef[]
): ChildLinkChangeEvent[] {
  const working = new Map<string, ChildIssueRef>();
  for (const child of currentChildren) {
    working.set(child.id, child);
  }

  const result: ChildLinkChangeEvent[] = new Array(changes.length);

  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];

    result[i] = {
      ...change,
      childrenAsOfEvent: Array.from(working.values()),
    };

    for (const added of change.addedChildren) {
      working.delete(added.id);
    }
    for (const removed of change.removedChildren) {
      working.set(removed.id, removed);
    }
  }

  return result;
}

function formatChildLine(child: ChildIssueRef): string {
  return `${child.idReadable} — ${child.summary}`;
}

/**
 * Builds 'dot' ChartIndicators for an issue's child-link-composition change
 * events (see parseChildLinkChanges/buildChildrenTimeline above). Each event
 * becomes one green (net > 0) or yellow (net < 0) dot, tooltip content per
 * product spec section 6 (as amended by the tester's note on section 4.5/
 * 6.1): the tooltip always shows the count "as of this moment"
 * (childrenAsOfEvent), and ADDITIONALLY — only on the LAST event on the
 * timeline — an explicit "current" count/using currentChildren, since a dot's
 * date is a historical event, never "now", but the product spec's literal
 * wording ("current count") still needs to be satisfied somewhere.
 */
export function buildChildLinkChangeIndicators(
  issueId: string,
  changes: ChildLinkChangeEvent[],
  currentChildren: ChildIssueRef[]
): ChartIndicator[] {
  return changes.map((change, idx) => {
    const isAddition = change.net > 0;
    const isLastEvent = idx === changes.length - 1;

    const tooltipTitle = isAddition
      ? (change.addedChildren.length > 1 ? 'Дочерние задачи добавлены' : 'Дочерняя задача добавлена')
      : 'Дочерняя задача удалена';

    const tooltipRows: { label: string; value: string }[] = [];

    for (const child of change.addedChildren) {
      tooltipRows.push({ label: '', value: `Добавлено: ${formatChildLine(child)}` });
    }
    for (const child of change.removedChildren) {
      tooltipRows.push({ label: '', value: `Удалено: ${formatChildLine(child)}` });
    }

    tooltipRows.push({ label: 'Дочерних задач на этот момент', value: String(change.childrenAsOfEvent.length) });
    if (isLastEvent) {
      tooltipRows.push({ label: 'Дочерних задач сейчас', value: String(currentChildren.length) });
    }

    tooltipRows.push({ label: '', value: 'Список дочерних задач:' });
    if (change.childrenAsOfEvent.length === 0) {
      tooltipRows.push({ label: '', value: 'Нет дочерних задач' });
    } else {
      const sorted = [...change.childrenAsOfEvent].sort((a, b) => a.idReadable.localeCompare(b.idReadable));
      for (const child of sorted) {
        tooltipRows.push({ label: '', value: formatChildLine(child) });
      }
    }

    return {
      kind: 'dot',
      semanticType: 'child-link-change',
      id: `${issueId}-child-link-${idx}-${change.changedAt}-${isAddition ? 'add' : 'remove'}`,
      date: change.changedAt,
      tooltipTitle,
      tooltipRows,
      color: isAddition ? '#4CAF50' : '#FFC107',
    };
  });
}

// ─── Assignee change indicators (assignee history) ──────────────────────────
//
// By analogy with the child-issues indicator above: an upward-pointing
// triangle event, green when an assignee was added, blue when one was
// removed, pinned to the bottom of the status bar. Field may be named
// "Assignee" (English) or "Исполнитель"/"Исполнители" (Russian, singular or
// plural) per product spec — matched via field name only (no $type-based
// fallback needed, mirroring the Estimated Date field-name-only detection
// style rather than the state field's dual $type+name strategy, since this
// is a single user-named field, not a fundamental cross-project concept).
// Unlike the child-issues indicator, no extra API call is needed for the
// "current" snapshot — see extractCurrentAssignees in resources.ts, which
// reads it straight off the already-fetched issue.fields.

const ASSIGNEE_FIELD_NAME_RE = /assignee|исполнител/i;

function toAssigneeRef(val: ActivityValue): AssigneeRef {
  return {
    id: val.id ?? '',
    displayName: val.name ?? val.login ?? val.id ?? 'Unknown',
  };
}

function filterAssigneeActivities(activities: IssueActivityItem[]): IssueActivityItem[] {
  return activities
    .filter((a) => ASSIGNEE_FIELD_NAME_RE.test(a.field?.name ?? ''))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Merges a day's worth of assignee-change activities into
 * AssigneeChangeEvent(s) — same per-day MERGE + net===0-split model as
 * parseChildLinkChanges (see that function's doc comment for the full
 * rationale): losing intermediate added/removed entries would make the
 * tooltip's per-day change list wrong, and an exact same-day add+remove
 * compensation splits into two honest events (one green, one blue) rather
 * than inventing one ambiguous-colored event.
 */
export function parseAssigneeChanges(activities: IssueActivityItem[]): AssigneeChangeEvent[] {
  const changes = filterAssigneeActivities(activities);
  if (changes.length === 0) return [];

  const byDay = new Map<string, IssueActivityItem[]>();
  for (const activity of changes) {
    const day = toDateString(activity.timestamp);
    const existing = byDay.get(day);
    if (existing) {
      existing.push(activity);
    } else {
      byDay.set(day, [activity]);
    }
  }

  const result: AssigneeChangeEvent[] = [];

  for (const dayActivities of byDay.values()) {
    const changedAt = dayActivities[dayActivities.length - 1].timestamp;

    const addedById = new Map<string, AssigneeRef>();
    const removedById = new Map<string, AssigneeRef>();
    for (const activity of dayActivities) {
      for (const v of toActivityValueArray(activity.added)) {
        if (typeof v !== 'object' || v === null) continue;
        addedById.set(v.id ?? '', toAssigneeRef(v));
      }
      for (const v of toActivityValueArray(activity.removed)) {
        if (typeof v !== 'object' || v === null) continue;
        removedById.set(v.id ?? '', toAssigneeRef(v));
      }
    }

    const addedAssignees = Array.from(addedById.values());
    const removedAssignees = Array.from(removedById.values());
    const net = addedAssignees.length - removedAssignees.length;

    if (net === 0 && addedAssignees.length > 0 && removedAssignees.length > 0) {
      result.push({
        changedAt,
        addedAssignees,
        removedAssignees: [],
        net: addedAssignees.length,
        assigneesAsOfEvent: [],
      });
      result.push({
        changedAt,
        addedAssignees: [],
        removedAssignees,
        net: -removedAssignees.length,
        assigneesAsOfEvent: [],
      });
    } else {
      result.push({ changedAt, addedAssignees, removedAssignees, net, assigneesAsOfEvent: [] });
    }
  }

  result.sort((a, b) => a.changedAt - b.changedAt);
  return result;
}

/**
 * Fills in `assigneesAsOfEvent` for each change via a BACKWARD pass from the
 * known-correct "now" snapshot (currentAssignees, from
 * extractCurrentAssignees) — mirrors buildChildrenTimeline exactly, see that
 * function's doc comment for why a backward pass (not forward-from-zero) is
 * used.
 */
export function buildAssigneesTimeline(
  changes: AssigneeChangeEvent[],
  currentAssignees: AssigneeRef[]
): AssigneeChangeEvent[] {
  const working = new Map<string, AssigneeRef>();
  for (const assignee of currentAssignees) {
    working.set(assignee.id, assignee);
  }

  const result: AssigneeChangeEvent[] = new Array(changes.length);

  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];

    result[i] = {
      ...change,
      assigneesAsOfEvent: Array.from(working.values()),
    };

    for (const added of change.addedAssignees) {
      working.delete(added.id);
    }
    for (const removed of change.removedAssignees) {
      working.set(removed.id, removed);
    }
  }

  return result;
}

function assigneeTooltipTitle(isAddition: boolean, names: string[]): string {
  const joined = names.join(', ');
  if (names.length > 1) {
    return isAddition ? `Добавлены исполнители: ${joined}` : `Сняты исполнители: ${joined}`;
  }
  return isAddition ? `Добавлен исполнитель ${joined}` : `Снят исполнитель ${joined}`;
}

/**
 * Builds 'triangle' ChartIndicators for an issue's assignee-composition
 * change events (see parseAssigneeChanges/buildAssigneesTimeline above).
 * Each event becomes one green (net > 0, added) or blue (net < 0, removed)
 * upward-pointing triangle. `label` carries the assignee count as of that
 * event — gantt-chart.tsx renders it inline to the right of the glyph, which
 * doubles as the always-visible "current count" the product spec asks for,
 * without the hover-only tradeoff the child-issues indicator had to settle
 * for (see docs/child-issues-indicator-spec.md §9.3).
 */
export function buildAssigneeChangeIndicators(
  issueId: string,
  changes: AssigneeChangeEvent[]
): ChartIndicator[] {
  return changes.map((change, idx) => {
    const isAddition = change.net > 0;
    const names = (isAddition ? change.addedAssignees : change.removedAssignees).map((a) => a.displayName);

    const tooltipRows: { label: string; value: string }[] = [
      { label: 'Всего исполнителей', value: String(change.assigneesAsOfEvent.length) },
      { label: '', value: 'Исполнители:' },
    ];
    if (change.assigneesAsOfEvent.length === 0) {
      tooltipRows.push({ label: '', value: 'Нет исполнителей' });
    } else {
      const sorted = [...change.assigneesAsOfEvent].sort((a, b) => a.displayName.localeCompare(b.displayName));
      for (const assignee of sorted) {
        tooltipRows.push({ label: '', value: assignee.displayName });
      }
    }

    return {
      kind: 'triangle',
      semanticType: 'assignee-change',
      id: `${issueId}-assignee-${idx}-${change.changedAt}-${isAddition ? 'add' : 'remove'}`,
      date: change.changedAt,
      tooltipTitle: assigneeTooltipTitle(isAddition, names),
      tooltipRows,
      label: String(change.assigneesAsOfEvent.length),
      color: isAddition ? '#4CAF50' : '#2196F3',
    };
  });
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
 * @param currentChildrenMap - Map of issueId -> current child issues from
 *   loadCurrentChildIssuesBatch(), used to build child-link-change 'dot'
 *   indicators (see buildChildLinkChangeIndicators). Optional/defaults to an
 *   empty map so existing callers that haven't wired this up yet still compile.
 * @returns Array of IssueStateHistoryData, one per issue with a usable timeline
 */
export function buildIssueStateHistoryData(
  issues: Issue[],
  activitiesMap: Map<string, IssueActivityItem[]>,
  statusOrder: StatusOrderItem[],
  currentChildrenMap: Map<string, ChildIssueRef[]> = new Map()
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

    // The activitiesPage response is one mixed list across all requested
    // categories (see ACTIVITY_CATEGORIES in resources.ts) — LinksCategory
    // items are structurally IssueLinkActivityItem (different added/removed
    // shape), not IssueActivityItem, even though they arrive in the same
    // array. Non-link activities simply won't have linkType/direction and
    // are filtered out by filterChildLinkActivities()'s category check.
    const linkActivities = activities as unknown as IssueLinkActivityItem[];
    const currentChildren = currentChildrenMap.get(issue.id) ?? [];
    const childLinkChanges = buildChildrenTimeline(
      parseChildLinkChanges(linkActivities),
      currentChildren
    );
    const childLinkIndicators = buildChildLinkChangeIndicators(issue.id, childLinkChanges, currentChildren);

    const currentAssignees = extractCurrentAssignees(issue);
    const assigneeChanges = buildAssigneesTimeline(parseAssigneeChanges(activities), currentAssignees);
    const assigneeIndicators = buildAssigneeChangeIndicators(issue.id, assigneeChanges);

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
        ...childLinkIndicators,
        ...assigneeIndicators,
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

/**
 * Exposes the raw LinksCategory activities + derived child-link-change
 * events for one issue, for the widget's debug-mode UI. This is the
 * troubleshooting hook that was used to confirm the real LinksCategory
 * activity shape (2026-07-03) against a live YouTrack project — see
 * filterChildLinkActivities() above. Kept in place for any future
 * discrepancy on other YouTrack versions/instances.
 */
export function getDebugChildLinkInfo(
  activities: IssueActivityItem[],
  currentChildren: ChildIssueRef[]
): {
  rawLinkActivities: IssueLinkActivityItem[];
  filteredActivities: IssueLinkActivityItem[];
  changes: ChildLinkChangeEvent[];
  currentChildren: ChildIssueRef[];
} {
  const linkActivities = activities as unknown as IssueLinkActivityItem[];
  const filteredActivities = filterChildLinkActivities(linkActivities);
  const changes = buildChildrenTimeline(parseChildLinkChanges(linkActivities), currentChildren);

  return {
    rawLinkActivities: linkActivities.filter((a) => a.category?.id === 'LinksCategory'),
    filteredActivities,
    changes,
    currentChildren,
  };
}

/**
 * Exposes the raw assignee-field activities + derived assignee-change
 * events for one issue, for the widget's debug-mode UI. This is the
 * troubleshooting hook for the Assignee/Исполнитель field-name heuristic in
 * filterAssigneeActivities() — since the exact field name/value shape
 * hasn't been confirmed against every real project's custom field setup,
 * this lets a user with debugMode on see exactly which activities matched
 * and what events/snapshot were derived from them, so a mismatch can be
 * quickly diagnosed the same way the child-issues indicator's LinksCategory
 * shape mismatch was (see getDebugChildLinkInfo above).
 */
export function getDebugAssigneeInfo(
  activities: IssueActivityItem[],
  currentAssignees: AssigneeRef[]
): {
  filteredActivities: IssueActivityItem[];
  changes: AssigneeChangeEvent[];
  currentAssignees: AssigneeRef[];
} {
  const filteredActivities = filterAssigneeActivities(activities);
  const changes = buildAssigneesTimeline(parseAssigneeChanges(activities), currentAssignees);

  return {
    filteredActivities,
    changes,
    currentAssignees,
  };
}
