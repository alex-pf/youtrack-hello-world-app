import type { EmbeddableWidgetAPI } from '../../../@types/globals';
import type {
  Issue,
  IssueActivityItem,
  ActivityPage,
  ProjectInfo,
  ProjectCustomFieldInfo,
  IssueType,
  StatusOrderItem,
} from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

export const ISSUES_PACK_SIZE = 50;

// Delay between batched activity requests to avoid rate-limiting (ms)
const ACTIVITY_BATCH_DELAY_MS = 100;

const ACTIVITY_CATEGORIES = 'CustomFieldCategory,IssueResolvedCategory';
const ACTIVITIES_PAGE_SIZE = 1000;
const MAX_PROJECTS = 200;

// ─── Field selector strings ──────────────────────────────────────────────────

const ISSUE_FIELDS =
  'id,idReadable,summary,resolved,created,updated,' +
  'fields(id,value(id,name,localizedName,presentation,color(id,foreground,background)),' +
  'projectCustomField(id,field(id,name,localizedName,fieldType(id,valueType))))';

const ACTIVITY_ITEM_FIELDS =
  'id,timestamp,author(id,name,login),category(id),' +
  'field(id,name),' +
  'added(id,name,presentation,value),' +
  'removed(id,name,presentation,value)';

// The activitiesPage endpoint returns ActivityCursorPage { activities, cursor, hasAfter }.
// We must wrap the item fields in activities(...) and also request cursor and hasAfter.
const ACTIVITY_FIELDS = `activities(${ACTIVITY_ITEM_FIELDS}),cursor,hasAfter`;

const PROJECT_FIELDS = 'id,name,shortName';

const PROJECT_CUSTOM_FIELD_FIELDS =
  'id,field(id,name,fieldType(id,valueType)),' +
  'bundle(id,values(id,name,ordinal,isResolved,color(id,background,foreground)))';

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

// ─── Issues ──────────────────────────────────────────────────────────────────

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

// ─── Projects ────────────────────────────────────────────────────────────────

export async function loadProjects(host: EmbeddableWidgetAPI): Promise<ProjectInfo[]> {
  return host.fetchYouTrack<ProjectInfo[]>('admin/projects', {
    query: {
      fields: PROJECT_FIELDS,
      $top: String(MAX_PROJECTS),
    },
  });
}

// ─── Project Custom Fields (states + types) ──────────────────────────────────

/**
 * Loads states and issue types for the given projects in parallel (one request
 * per project instead of 2N sequential requests).
 */
export async function loadProjectCustomFields(
  host: EmbeddableWidgetAPI,
  projectIds: string[]
): Promise<{ states: StatusOrderItem[]; types: IssueType[] }> {
  const allStates: Map<string, StatusOrderItem> = new Map();
  const allTypes: Map<string, IssueType> = new Map();

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
      const fieldName = cf.field?.name?.toLowerCase() ?? '';

      // State-type fields
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

      // Exact "Type" enum field
      if (fieldName === 'type' && valueType.includes('enum') && cf.bundle?.values) {
        for (const val of cf.bundle.values) {
          if (!allTypes.has(val.id)) {
            allTypes.set(val.id, { id: val.id, name: val.name });
          }
        }
      }
    }
  }

  return {
    states: Array.from(allStates.values()),
    types: Array.from(allTypes.values()),
  };
}

/** @deprecated Use loadProjectCustomFields instead */
export async function loadProjectStates(
  host: EmbeddableWidgetAPI,
  projectIds: string[]
): Promise<StatusOrderItem[]> {
  return (await loadProjectCustomFields(host, projectIds)).states;
}

/** @deprecated Use loadProjectCustomFields instead */
export async function loadIssueTypes(
  host: EmbeddableWidgetAPI,
  projectIds: string[]
): Promise<IssueType[]> {
  return (await loadProjectCustomFields(host, projectIds)).types;
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
      `[issues-progress] Activity page for issue ${issueId} has more entries beyond the first ${ACTIVITIES_PAGE_SIZE}. ` +
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

// ─── Helper: extract issue type name from issue fields ───────────────────────

export function extractIssueTypeName(issue: Issue): string | undefined {
  const typeField = issue.fields.find(
    (f) => f.projectCustomField?.field?.name?.toLowerCase() === 'type'
  );
  if (!typeField) return undefined;
  const val = typeField.value;
  if (Array.isArray(val)) return val[0]?.name;
  return (val as { name?: string } | null)?.name;
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
 * @param onProgress - Optional progress callback (loaded, total)
 * @returns Object with issues array and activitiesMap
 */
export async function loadIssuesWithActivities(
  host: EmbeddableWidgetAPI,
  search: string,
  onProgress?: (phase: 'issues' | 'activities', loaded: number, total: number) => void
): Promise<{ issues: Issue[]; activitiesMap: Map<string, IssueActivityItem[]> }> {
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
    return { issues: [], activitiesMap: new Map() };
  }

  // Phase 2: Load activities for all issues in batches
  const issueIds = allIssues.map((i) => i.id);
  const activitiesMap = await loadActivitiesBatch(host, issueIds, (loaded, total) => {
    onProgress?.('activities', loaded, total);
  });

  return { issues: allIssues, activitiesMap };
}