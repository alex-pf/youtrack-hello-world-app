import type { EmbeddableWidgetAPI } from '../../../@types/globals';
import type { Issue, IssueActivityItem, StatusOrderItem } from './types';
import { extractGroupFieldValue, loadIssuesWithActivities } from './resources';
import { findLeadTimeStartAt } from './activity-parser';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ─── Percentile math ───────────────────────────────────────────────────────

/**
 * Linear interpolation percentile (R-7 / numpy 'linear' / Excel
 * PERCENTILE.INC) — see docs/PROGRESS_TRACKING_SPEC.md section 5.
 *
 * `sortedAscending` must already be sorted ascending and non-empty; the
 * n===0 case is the caller's responsibility (see computeGroupPercentiles).
 */
export function computePercentile(sortedAscending: number[], p: number): number {
  const n = sortedAscending.length;
  const index = (p / 100) * (n - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sortedAscending[lower];
  const upperValue = sortedAscending[upper];
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

/**
 * Computes {p50, p80} per group from raw (unsorted) lead-time-days arrays.
 * A group with an empty array maps to null — "no background zone for this
 * group" per spec section 5 (n=0: no resolved issues in the group).
 * A group with exactly one value maps p50 and p80 both to that value.
 */
export function computeGroupPercentiles(
  leadTimeDaysByGroup: Map<string, number[]>
): Map<string, { p50: number; p80: number } | null> {
  const result = new Map<string, { p50: number; p80: number } | null>();

  for (const [group, days] of leadTimeDaysByGroup.entries()) {
    if (days.length === 0) {
      result.set(group, null);
      continue;
    }
    if (days.length === 1) {
      result.set(group, { p50: days[0], p80: days[0] });
      continue;
    }
    const sorted = [...days].sort((a, b) => a - b);
    result.set(group, {
      p50: computePercentile(sorted, 50),
      p80: computePercentile(sorted, 80),
    });
  }

  return result;
}

// ─── Lead time for a single resolved issue ─────────────────────────────────

/**
 * Lead time in days for a resolved issue, computed directly from Issue +
 * activities + statusOrder (independent of activity-parser's
 * buildChartData/IssueChartData) — see the caller-facing note in
 * docs/PROGRESS_TRACKING_SPEC.md section 5: the percentile sample can include
 * issues outside the already-rendered IssueChartData[] dataset (when
 * additionalSearch narrows the chart but not the percentile base), so this
 * must not depend on totalDays from an already-built chart dataset.
 *
 * Returns null when the issue isn't resolved, or (defensively) when the
 * computed lead time is negative or NaN.
 */
export function leadTimeDaysForResolvedIssue(
  issue: Issue,
  activities: IssueActivityItem[],
  statusOrder: StatusOrderItem[]
): number | null {
  if (issue.resolved === null) return null;

  const issueCreatedAt = issue.created ?? issue.resolved;
  const leadTimeStartAt = findLeadTimeStartAt(activities, statusOrder, issueCreatedAt);
  const days = (issue.resolved - leadTimeStartAt) / MS_PER_DAY;

  if (Number.isNaN(days) || days < 0) return null;
  return days;
}

// ─── Group query builder ────────────────────────────────────────────────────

/**
 * Builds the YouTrack query for a group's percentile sample:
 * `(primarySearch) and (groupByField: {groupValue})` — see
 * docs/PROGRESS_TRACKING_SPEC.md section 8, assumption 3 (curly braces
 * around the value are YouTrack's syntax for values containing spaces).
 *
 * Known limitation: for the "no value" group (`groupValue === ''`, see
 * groupChartData's '' key in activity-parser.ts), there is no reliable
 * cross-localization YouTrack syntax for "field is not set" in the general
 * case, so this simply returns `primarySearch` unchanged — meaning the
 * percentiles computed for the "no value" group in the additionalSearch-set
 * branch are actually computed over the ENTIRE primarySearch resolved
 * sample, not strictly "field unset". This is a deliberate, documented
 * simplification, not a bug.
 */
export function buildGroupQuery(
  primarySearch: string,
  groupByField: string,
  groupValue: string
): string {
  if (groupValue === '') return primarySearch;
  return `(${primarySearch}) and (${groupByField}: {${groupValue}})`;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

function collectLeadTimesByGroup(
  issues: Issue[],
  activitiesMap: Map<string, IssueActivityItem[]>,
  statusOrder: StatusOrderItem[],
  groupByField: string,
  groupValues: string[]
): Map<string, number[]> {
  const byGroup = new Map<string, number[]>();
  for (const groupValue of groupValues) {
    byGroup.set(groupValue, []);
  }

  for (const issue of issues) {
    const key = extractGroupFieldValue(issue, groupByField) ?? '';
    if (!byGroup.has(key)) continue; // not one of the requested groups
    const activities = activitiesMap.get(issue.id) ?? [];
    const days = leadTimeDaysForResolvedIssue(issue, activities, statusOrder);
    if (days === null) continue;
    byGroup.get(key)!.push(days);
  }

  return byGroup;
}

/**
 * Computes {p50, p80} lead-time percentiles per group, per
 * docs/PROGRESS_TRACKING_SPEC.md section 5 "Источник данных для расчёта":
 *
 * - additionalSearch empty: reuses `alreadyLoaded` (the primary+additional
 *   dataset already fetched for rendering) with no extra REST calls — valid
 *   because with no additionalSearch narrowing, "primarySearch AND
 *   groupByField=G" is exactly what's already loaded.
 * - additionalSearch non-empty: issues a separate
 *   `loadIssuesWithActivities` request per group value (in parallel via
 *   Promise.all — the number of groups is typically small, unlike the
 *   per-issue activity fetches inside loadIssuesWithActivities, which stay
 *   sequential/throttled as-is).
 */
export async function fetchGroupPercentiles(
  host: EmbeddableWidgetAPI,
  params: {
    primarySearch: string;
    additionalSearch: string;
    groupByField: string;
    statusOrder: StatusOrderItem[];
    groupValues: string[];
    alreadyLoaded: { issues: Issue[]; activitiesMap: Map<string, IssueActivityItem[]> };
  }
): Promise<Map<string, { p50: number; p80: number } | null>> {
  const { primarySearch, additionalSearch, groupByField, statusOrder, groupValues, alreadyLoaded } =
    params;

  if (additionalSearch.trim() === '') {
    const byGroup = collectLeadTimesByGroup(
      alreadyLoaded.issues,
      alreadyLoaded.activitiesMap,
      statusOrder,
      groupByField,
      groupValues
    );
    return computeGroupPercentiles(byGroup);
  }

  const perGroupResults = await Promise.all(
    groupValues.map(async (groupValue) => {
      const query = buildGroupQuery(primarySearch, groupByField, groupValue);
      const { issues, activitiesMap } = await loadIssuesWithActivities(host, query);
      const days: number[] = [];
      for (const issue of issues) {
        // For the "no value" group, buildGroupQuery deliberately returns the
        // unfiltered primarySearch (no reliable "field unset" YouTrack
        // syntax — see buildGroupQuery's doc comment), so the percentile
        // sample here is the entire resolved primarySearch population, not
        // narrowed to key === ''. For real group values, guard against the
        // query narrowing being imperfect by re-checking the field value.
        if (groupValue !== '') {
          const key = extractGroupFieldValue(issue, groupByField) ?? '';
          if (key !== groupValue) continue;
        }
        const activities = activitiesMap.get(issue.id) ?? [];
        const d = leadTimeDaysForResolvedIssue(issue, activities, statusOrder);
        if (d !== null) days.push(d);
      }
      return [groupValue, days] as const;
    })
  );

  const byGroup = new Map<string, number[]>(perGroupResults);
  return computeGroupPercentiles(byGroup);
}
