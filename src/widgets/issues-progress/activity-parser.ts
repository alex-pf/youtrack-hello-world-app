import {
  IssueActivityItem,
  ActivityValue,
  Issue,
  IssueChartData,
  StatusSegment,
  EstimateDateChange,
  StatusOrderItem,
} from './types';

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
  // Filter to state-change activities only
  // YouTrack state changes appear as CustomFieldChanges where field.name === 'State'
  const stateChanges = activities
    .filter(
      (a) =>
        a.field?.name?.toLowerCase() === 'state' ||
        (a.category?.id === 'CustomFieldChanges' &&
          a.field?.customField?.fieldType?.valueType?.toLowerCase().includes('state'))
    )
    .sort((a, b) => a.timestamp - b.timestamp);

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
        fieldName.includes('deadline') ||
        // Also match by field type: date fields
        a.field?.customField?.fieldType?.valueType?.toLowerCase() === 'date'
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

    // Date field values come as numbers (Unix ms) or null
    const parseDate = (vals: ActivityValue[]): number | null => {
      if (vals.length === 0) return null;
      const val = vals[0];
      // The value might be in `presentation` (formatted date string) or as a raw number
      // Try to parse as number first, then as date string
      if (typeof (val as unknown as { value: number }).value === 'number') {
        return (val as unknown as { value: number }).value;
      }
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

// ─── Main Aggregator ──────────────────────────────────────────────────────────

/**
 * Combines issue data with its activity history to produce chart-ready IssueChartData.
 *
 * @param issue - Issue object from loadIssues()
 * @param activities - Activity items from loadIssueActivities()
 * @param statusOrder - Ordered statuses from widget config
 * @param showEstimateDate - Whether to parse estimate date history
 * @returns IssueChartData ready for the Gantt chart
 */
export function buildIssueChartData(
  issue: Issue,
  activities: IssueActivityItem[],
  statusOrder: StatusOrderItem[],
  showEstimateDate: boolean
): IssueChartData {
  const segments = parseStateSegments(
    issue.id,
    activities,
    statusOrder,
    issue.created ?? Date.now()
  );

  const estimateDateChanges = showEstimateDate
    ? parseEstimateDateChanges(issue.id, activities)
    : [];

  const totalDays = segments.reduce((sum, s) => sum + s.durationDays, 0);

  // Extract issue type from fields
  const typeField = issue.fields?.find(
    (f) => f.projectCustomField?.field?.name?.toLowerCase() === 'type'
  );
  let issueType: string | undefined;
  if (typeField?.value) {
    const val = typeField.value;
    if (Array.isArray(val)) {
      issueType = val[0]?.name;
    } else {
      issueType = (val as { name?: string })?.name;
    }
  }

  return {
    issueId: issue.id,
    idReadable: issue.idReadable,
    summary: issue.summary,
    issueType,
    segments,
    estimateDateChanges,
    totalDays,
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
 * @returns Array of IssueChartData sorted by totalDays descending
 */
export function buildChartData(
  issues: Issue[],
  activitiesMap: Map<string, IssueActivityItem[]>,
  statusOrder: StatusOrderItem[],
  showEstimateDate: boolean
): IssueChartData[] {
  const chartData: IssueChartData[] = [];

  for (const issue of issues) {
    const activities = activitiesMap.get(issue.id) ?? [];
    const data = buildIssueChartData(issue, activities, statusOrder, showEstimateDate);
    // Include issues even with no segments (they'll show as empty rows)
    chartData.push(data);
  }

  // Sort by totalDays descending (longest issues at top)
  chartData.sort((a, b) => b.totalDays - a.totalDays);
  return chartData;
}