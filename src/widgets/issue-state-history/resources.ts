import type { EmbeddableWidgetAPI } from '../../../@types/globals';
import type {
  ProjectInfo,
  ProjectCustomFieldInfo,
  StatusOrderItem,
  Issue,
  IssueActivityItem,
  ActivityPage,
  ChildIssueRef,
} from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_PROJECTS = 200;
const ISSUES_PACK_SIZE = 50;
// LinksCategory added for the child issues indicator (Родитель для / Subtask
// link activities) — see activity-parser.ts filterChildLinkActivities().
// UNTESTED against real project data: the exact category name/shape for link
// activities hasn't been confirmed against a live YouTrack instance.
const ACTIVITY_CATEGORIES = 'CustomFieldCategory,IssueResolvedCategory,LinksCategory';
const ACTIVITIES_PAGE_SIZE = 1000;
// Delay between batched activity requests to avoid rate-limiting (ms)
const ACTIVITY_BATCH_DELAY_MS = 100;

// ─── Field selector strings ──────────────────────────────────────────────────

const PROJECT_FIELDS = 'id,name,shortName';

const PROJECT_CUSTOM_FIELD_FIELDS =
  'id,field(id,name,fieldType(id,valueType)),' +
  'bundle(id,values(id,name,ordinal,isResolved,color(id,background,foreground)))';

// Includes `fields(...)` so the current State value is available as a
// fallback for issues that have never had a state-change activity (e.g.
// still sitting in their initial default status) — see extractCurrentState.
const ISSUE_FIELDS =
  'id,idReadable,summary,resolved,created,updated,' +
  'fields(id,value(id,name,localizedName,presentation),' +
  'projectCustomField(id,field(id,name,localizedName,fieldType(id,valueType))))';

// A single activitiesPage request returns ALL category items mixed together
// (CustomFieldCategory, IssueResolvedCategory, LinksCategory), so the fields
// projection must cover both custom-field-style activities AND link-style
// activities at once — YouTrack simply leaves the non-applicable fields
// empty for a given activity's actual type, it does not error. added/removed
// need BOTH the custom-field projection (name,presentation,value) and the
// link projection (idReadable,summary) since the same fields string is used
// for every activity regardless of category.
const ACTIVITY_ITEM_FIELDS =
  'id,timestamp,author(id,name,login),category(id),' +
  'field(id,name),' +
  'linkType(id,name,localizedName,sourceToTarget,targetToSource,directed),direction,' +
  'added(id,name,presentation,value,idReadable,summary),' +
  'removed(id,name,presentation,value,idReadable,summary)';

// The activitiesPage endpoint returns ActivityCursorPage { activities, cursor, hasAfter }.
// We must wrap the item fields in activities(...) and also request cursor and hasAfter.
const ACTIVITY_FIELDS = `activities(${ACTIVITY_ITEM_FIELDS}),cursor,hasAfter`;

// Fields projection for GET issues/{id}/links — used to read the CURRENT
// (as-of-now) set of child issues via loadCurrentChildIssues(). Filtered
// client-side to the "Subtask"/"Родитель для" outward direction, same family
// match as filterChildLinkActivities() in activity-parser.ts.
const ISSUE_LINKS_FIELDS =
  'id,direction,' +
  'linkType(id,name,localizedName,sourceToTarget,targetToSource,directed),' +
  'issues(id,idReadable,summary)';

// ─── Query Assist ────────────────────────────────────────────────────────────

const QUERY_ASSIST_FIELDS =
  'query,caret,styleRanges(start,length,style),suggestions(prefix,option,suffix,description,matchingStart,matchingEnd,caret,completionStart,completionEnd,group,icon)';

interface RawAssistResponse {
  query?: string;
  caret?: number;
  styleRanges?: Array<{ start: number; length: number; style: string }>;
  suggestions?: Array<Record<string, unknown>>;
}

export async function queryAssistDataSource(
  host: EmbeddableWidgetAPI,
  params: { query: string; caret: number }
) {
  const raw = await host.fetchYouTrack<RawAssistResponse>('search/assist', {
    method: 'POST',
    query: {
      fields: QUERY_ASSIST_FIELDS,
    },
    body: {
      query: params.query,
      caret: params.caret,
    },
  });

  // Normalize suggestions — Ring UI requires `description` and `group` as strings
  const suggestions = (raw.suggestions || []).map((s) => ({
    prefix: (s.prefix as string) || '',
    option: (s.option as string) || '',
    suffix: (s.suffix as string) || '',
    description: (s.description as string) || '',
    group: (s.group as string) || '',
    matchingStart: s.matchingStart as number | undefined,
    matchingEnd: s.matchingEnd as number | undefined,
    caret: s.caret as number | undefined,
    completionStart: s.completionStart as number | undefined,
    completionEnd: s.completionEnd as number | undefined,
    icon: s.icon as string | undefined,
  }));

  return {
    query: raw.query,
    caret: raw.caret,
    styleRanges: raw.styleRanges as Array<{ start: number; length: number; style: string }> | undefined,
    suggestions,
  };
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function loadProjects(host: EmbeddableWidgetAPI): Promise<ProjectInfo[]> {
  return host.fetchYouTrack<ProjectInfo[]>('admin/projects', {
    query: {
      fields: PROJECT_FIELDS,
      $top: String(MAX_PROJECTS),
    },
  });
}

// ─── Project States (for status order selection) ─────────────────────────────

/**
 * Loads available states for the given projects in parallel (one request per
 * project). Only the state-type custom field values are needed here — issue
 * type loading (used by issues-progress for LT settings) is out of scope for
 * this widget's configuration UI.
 */
export async function loadProjectStates(
  host: EmbeddableWidgetAPI,
  projectIds: string[]
): Promise<StatusOrderItem[]> {
  const allStates: Map<string, StatusOrderItem> = new Map();

  const perProjectFields = await Promise.all(
    projectIds.map((projectId) =>
      host.fetchYouTrack<ProjectCustomFieldInfo[]>(
        `admin/projects/${projectId}/customFields`,
        {
          query: { fields: PROJECT_CUSTOM_FIELD_FIELDS },
        }
      )
    )
  );

  for (const fields of perProjectFields) {
    for (const cf of fields) {
      const valueType = cf.field?.fieldType?.valueType?.toLowerCase() ?? '';

      if (valueType.includes('state') && cf.bundle?.values) {
        for (const val of cf.bundle.values) {
          if (!allStates.has(val.id)) {
            allStates.set(val.id, {
              id: val.id,
              name: val.name,
              color: val.color?.background,
            });
          }
        }
      }
    }
  }

  return Array.from(allStates.values());
}

// ─── Issues ──────────────────────────────────────────────────────────────────

/**
 * Reads an issue's current State field value (id + name), used as a fallback
 * for issues that have never had a state-change activity — e.g. an issue
 * still sitting in its initial default status, which YouTrack does not log
 * as a "change" activity. Without this fallback such issues would have no
 * usable timeline at all and would be (incorrectly) excluded from the chart.
 */
export function extractCurrentState(issue: Issue): { id: string; name: string } | undefined {
  const stateField = issue.fields.find(
    (f) => f.projectCustomField?.field?.fieldType?.valueType?.toLowerCase().includes('state')
  );
  if (!stateField) return undefined;
  const val = stateField.value;
  const single = Array.isArray(val) ? val[0] : val;
  if (!single?.name) return undefined;
  return { id: single.id ?? '', name: single.name };
}

/**
 * Reads an issue's CURRENT Estimated Date custom field value, if set.
 *
 * Approach (b) from the task spec: read directly from the issue's `fields`
 * array (already fetched via ISSUE_FIELDS, which includes the generic
 * `fields(...)` selector added for extractCurrentState) rather than
 * inferring it from the last "Estimated Date changed" activity. This is
 * more reliable — it always reflects the true current value, including
 * issues where the field was set at creation time and never subsequently
 * changed (which would have NO activity entry for approach (a)).
 *
 * Field name matching mirrors parseEstimateDateChanges() in
 * activity-parser.ts: language-independent substring match against common
 * English field names ("estimated", "due date", "deadline").
 *
 * IMPORTANT: unlike enum/state fields (whose `value` is a BundleElement
 * object with id/name/color), a `DateIssueCustomField`'s `value` in
 * YouTrack's REST API is typically a RAW PRIMITIVE (a number, or a numeric
 * string) — not an object. The `value(id,name,localizedName,presentation)`
 * projection in ISSUE_FIELDS was written for enum fields; against a
 * primitive it's a no-op and the server just returns the primitive as-is.
 * So we must check for a primitive FIRST, before assuming an object shape.
 *
 * @returns Unix ms timestamp, or null if the issue has no Estimated Date
 *   field configured/set at all (per product spec: no value → no flag).
 */
export function extractCurrentEstimatedDate(issue: Issue): number | null {
  const dateField = issue.fields.find((f) => {
    const fieldName = f.projectCustomField?.field?.name?.toLowerCase() ?? '';
    return (
      fieldName.includes('estimated') ||
      fieldName.includes('due date') ||
      fieldName.includes('deadline')
    );
  });
  if (!dateField) return null;

  const val = dateField.value;
  const single = Array.isArray(val) ? val[0] : val;
  if (single === null || single === undefined) return null;

  // Case 1: raw primitive (number or numeric string) — the common case for
  // DateIssueCustomField, see the note above.
  if (typeof single === 'number') {
    return single > 0 ? single : null;
  }
  if (typeof single === 'string') {
    const asNum = Number(single);
    if (!isNaN(asNum) && asNum > 0) return asNum;
    const asDate = Date.parse(single);
    if (!isNaN(asDate)) return asDate;
    return null;
  }

  // Case 2: object shape (id/name/presentation) — fallback in case the API
  // does wrap the value for this field, or for defensive robustness.
  const idNum = single.id !== undefined ? Number(single.id) : NaN;
  if (!isNaN(idNum) && idNum > 0) return idNum;

  if (single.name) {
    const nameNum = Number(single.name);
    if (!isNaN(nameNum) && nameNum > 0) return nameNum;
  }

  if (single.presentation) {
    const parsed = Date.parse(single.presentation);
    if (!isNaN(parsed)) return parsed;
  }

  return null;
}

export async function loadIssues(
  host: EmbeddableWidgetAPI,
  search: string,
  skip = 0
): Promise<Issue[]> {
  return host.fetchYouTrack<Issue[]>('issues', {
    query: {
      fields: ISSUE_FIELDS,
      query: search || '',
      $top: String(ISSUES_PACK_SIZE),
      $skip: String(skip),
    },
  });
}

export async function loadIssuesCount(
  host: EmbeddableWidgetAPI,
  search: string
): Promise<number> {
  const result = await host.fetchYouTrack<{ count: number }>('issuesGetter/count', {
    method: 'POST',
    query: { fields: 'count' },
    body: { folder: null, query: search || null },
  });
  return result?.count ?? 0;
}

// ─── Issue Activities ────────────────────────────────────────────────────────

export async function loadIssueActivities(
  host: EmbeddableWidgetAPI,
  issueId: string
): Promise<IssueActivityItem[]> {
  const page = await host.fetchYouTrack<ActivityPage>(
    `issues/${issueId}/activitiesPage`,
    {
      query: {
        fields: ACTIVITY_FIELDS,
        categories: ACTIVITY_CATEGORIES,
        $top: ACTIVITIES_PAGE_SIZE,
      },
    }
  );
  if (page?.hasAfter === true) {
    console.warn(
      `[issue-state-history] Activity page for issue ${issueId} has more entries beyond the first ${ACTIVITIES_PAGE_SIZE}. ` +
      'Some activity history may be truncated.'
    );
  }
  return page?.activities ?? [];
}

// ─── Batch Activity Loading ──────────────────────────────────────────────────

/**
 * Loads activities for multiple issues sequentially with a delay between
 * requests to avoid hitting YouTrack rate limits.
 *
 * @param host - EmbeddableWidgetAPI instance
 * @param issueIds - Array of internal issue IDs
 * @param onProgress - Optional callback called after each issue is loaded (loaded, total)
 * @returns Map of issueId → activities array
 */
export async function loadActivitiesBatch(
  host: EmbeddableWidgetAPI,
  issueIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<Map<string, IssueActivityItem[]>> {
  const result = new Map<string, IssueActivityItem[]>();

  for (let i = 0; i < issueIds.length; i++) {
    const issueId = issueIds[i];
    try {
      const activities = await loadIssueActivities(host, issueId);
      result.set(issueId, activities);
    } catch (e) {
      // On error for a single issue, store empty array and continue
      console.warn(`Failed to load activities for issue ${issueId}:`, e);
      result.set(issueId, []);
    }

    onProgress?.(i + 1, issueIds.length);

    // Throttle: wait between requests (skip delay after last item)
    if (i < issueIds.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, ACTIVITY_BATCH_DELAY_MS));
    }
  }

  return result;
}

// ─── Current Child Issues ────────────────────────────────────────────────────

// Same family-match regex as filterChildLinkActivities() in
// activity-parser.ts — kept in sync deliberately so "current children" (this
// file) and "child link change events" (activity-parser.ts) agree on what
// counts as a "Родитель для"/"Subtask" outward link.
const SUBTASK_LINK_TYPE_RE = /subtask|подзадач/i;
const PARENT_FOR_RE = /родитель для|parent for/i;

interface IssueLinkEntry {
  id: string;
  direction?: 'OUTWARD' | 'INWARD' | 'BOTH' | string;
  linkType?: {
    name?: string;
    localizedName?: string;
    sourceToTarget?: string;
    targetToSource?: string;
  };
  issues?: { id: string; idReadable: string; summary: string }[];
}

/**
 * Reads the CURRENT (as-of-now) list of child issues for one issue, via
 * issues/{id}/links — a new API surface, not used anywhere else in this
 * project. Only links whose type matches the "Subtask"/"Родитель для" family
 * AND whose direction is outward (this issue is the parent) are counted —
 * same direction rule as filterChildLinkActivities() in activity-parser.ts,
 * so the "current" snapshot and the historical change events agree on what
 * counts as a child.
 *
 * UNTESTED against real project data (see risk notes in activity-parser.ts
 * above filterChildLinkActivities) — direction detection falls back to
 * matching linkType.sourceToTarget against "Родитель для"/"Parent for" when
 * the `direction` field itself isn't present in the API response.
 */
export async function loadCurrentChildIssues(
  host: EmbeddableWidgetAPI,
  issueId: string
): Promise<ChildIssueRef[]> {
  const links = await host.fetchYouTrack<IssueLinkEntry[]>(`issues/${issueId}/links`, {
    query: { fields: ISSUE_LINKS_FIELDS },
  });

  const children: ChildIssueRef[] = [];
  for (const link of links ?? []) {
    const typeName = link.linkType?.name ?? '';
    const typeLocalized = link.linkType?.localizedName ?? '';
    const isSubtaskFamily = SUBTASK_LINK_TYPE_RE.test(typeName) || SUBTASK_LINK_TYPE_RE.test(typeLocalized);
    if (!isSubtaskFamily) continue;

    const isOutward = link.direction
      ? link.direction === 'OUTWARD'
      : PARENT_FOR_RE.test(link.linkType?.sourceToTarget ?? '');
    if (!isOutward) continue;

    for (const issue of link.issues ?? []) {
      children.push({
        id: issue.id,
        idReadable: issue.idReadable,
        summary: issue.summary ?? issue.idReadable,
      });
    }
  }
  return children;
}

/**
 * Batch version of loadCurrentChildIssues(), following the exact same
 * sequential + delay pattern as loadActivitiesBatch() above (to stay under
 * the same rate-limiting budget).
 *
 * @param host - EmbeddableWidgetAPI instance
 * @param issueIds - Array of internal issue IDs
 * @param onProgress - Optional callback called after each issue is loaded (loaded, total)
 * @returns Map of issueId → current child issues array
 */
export async function loadCurrentChildIssuesBatch(
  host: EmbeddableWidgetAPI,
  issueIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<Map<string, ChildIssueRef[]>> {
  const result = new Map<string, ChildIssueRef[]>();

  for (let i = 0; i < issueIds.length; i++) {
    const issueId = issueIds[i];
    try {
      const children = await loadCurrentChildIssues(host, issueId);
      result.set(issueId, children);
    } catch (e) {
      // On error for a single issue, store empty array and continue
      console.warn(`Failed to load current child issues for issue ${issueId}:`, e);
      result.set(issueId, []);
    }

    onProgress?.(i + 1, issueIds.length);

    // Throttle: wait between requests (skip delay after last item)
    if (i < issueIds.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, ACTIVITY_BATCH_DELAY_MS));
    }
  }

  return result;
}

// ─── Orchestrated Data Loading ────────────────────────────────────────────────

/**
 * Loads all issues matching the search query, then loads their activity histories
 * in batches. Returns both the raw issues and the activities map.
 *
 * This is the main data loading function called by app.tsx.
 *
 * @param host - EmbeddableWidgetAPI instance
 * @param search - YouTrack search query string
 * @param onProgress - Optional progress callback (phase, loaded, total)
 * @returns Object with issues array, activitiesMap, and currentChildrenMap
 */
export async function loadIssuesWithActivities(
  host: EmbeddableWidgetAPI,
  search: string,
  onProgress?: (phase: 'issues' | 'activities' | 'children', loaded: number, total: number) => void
): Promise<{
  issues: Issue[];
  activitiesMap: Map<string, IssueActivityItem[]>;
  currentChildrenMap: Map<string, ChildIssueRef[]>;
}> {
  // Phase 1: Load all issues (paginated)
  const allIssues: Issue[] = [];
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const batch = await loadIssues(host, search, skip);
    allIssues.push(...batch);
    skip += batch.length;
    hasMore = batch.length === ISSUES_PACK_SIZE;
    onProgress?.('issues', allIssues.length, -1);
  }

  if (allIssues.length === 0) {
    return { issues: [], activitiesMap: new Map(), currentChildrenMap: new Map() };
  }

  // Phase 2: Load activities for all issues in batches
  const issueIds = allIssues.map((i) => i.id);
  const activitiesMap = await loadActivitiesBatch(host, issueIds, (loaded, total) => {
    onProgress?.('activities', loaded, total);
  });

  // Phase 3: Load each issue's CURRENT child issues (API add-on, not derived
  // from activities) — the reliable "now" snapshot buildChildrenTimeline()
  // backward-fills from. Kept inside this orchestrator (rather than a
  // separate call site in app.tsx) so there's a single place that owns the
  // "issues -> activities -> children" loading sequence.
  const currentChildrenMap = await loadCurrentChildIssuesBatch(host, issueIds, (loaded, total) => {
    onProgress?.('children', loaded, total);
  });

  return { issues: allIssues, activitiesMap, currentChildrenMap };
}
