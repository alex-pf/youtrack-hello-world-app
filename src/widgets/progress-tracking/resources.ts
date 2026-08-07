import type { EmbeddableWidgetAPI } from '../../../@types/globals';
import type {
  Issue,
  IssueActivityItem,
  ActivityPage,
  ProjectInfo,
  ProjectCustomFieldInfo,
  StatusOrderItem,
  GroupableField,
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

// localizedName is included alongside name because a project can rename its
// display label for a field (e.g. a field technically named "Client type"
// shown to users as "Type") — see loadProjectCustomFields/extractGroupFieldValue,
// which match against either.
const PROJECT_CUSTOM_FIELD_FIELDS =
  'id,field(id,name,localizedName,fieldType(id,valueType)),' +
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

// ─── Project Custom Fields (states + groupable enum fields) ─────────────────

/**
 * Loads states and groupable enum fields for the given projects in parallel
 * (one request per project instead of 2N sequential requests).
 *
 * `states` is keyed by NAME (case-insensitive), not by bundle element id —
 * state fields are typically configured per-project, so the same-named value
 * (e.g. "To Do") usually has a DIFFERENT id in each project. Keying by id
 * would list it once per project on a multi-project dashboard, producing a
 * checkbox list with many visually-identical entries. The first project's
 * id/color for a given name wins; downstream matching (parseStateSegments,
 * findLeadTimeStartAt) already falls back to name when ids differ, so a
 * single representative id per name is sufficient.
 *
 * `groupableFields` aggregates ALL enum-typed custom fields (not just
 * "Type") across the given projects, keyed by field name (case-insensitive,
 * preferring localizedName when name is empty) — see
 * docs/PROGRESS_TRACKING_SPEC.md section 8, assumption 1: only fields whose
 * valueType contains "enum" AND that have a non-empty bundle are candidates;
 * state/version/build/ownedField/user fields are excluded even though they
 * are also bundle-backed.
 */
export async function loadProjectCustomFields(
  host: EmbeddableWidgetAPI,
  projectIds: string[]
): Promise<{ states: StatusOrderItem[]; groupableFields: GroupableField[] }> {
  const allStates: Map<string, StatusOrderItem> = new Map();
  const allGroupableFields: Map<string, GroupableField> = new Map();

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
      const fieldName = cf.field?.name ?? '';
      const fieldLocalizedName = cf.field?.localizedName ?? '';

      // State-type fields
      if (valueType.includes('state') && cf.bundle?.values) {
        for (const val of cf.bundle.values) {
          const key = val.name.toLowerCase();
          if (!allStates.has(key)) {
            allStates.set(key, {
              id: val.id,
              name: val.name,
              color: val.color?.background,
            });
          }
        }
      }

      // Strictly-enum fields (bundle-backed, valueType includes "enum") are
      // candidates for grouping. This deliberately excludes state/version/
      // build/ownedField/user fields, which are also bundle-backed but do
      // not match "enum" in their valueType.
      if (valueType.includes('enum') && cf.bundle?.values && cf.bundle.values.length > 0) {
        const displayName = fieldName || fieldLocalizedName;
        const key = displayName.toLowerCase();
        if (key) {
          const existing = allGroupableFields.get(key);
          if (!existing) {
            allGroupableFields.set(key, {
              name: fieldName,
              localizedName: fieldLocalizedName || undefined,
              values: cf.bundle.values.map((val) => ({
                id: val.id,
                name: val.name,
                ordinal: val.ordinal,
              })),
            });
          } else {
            // Merge in any bundle values not already present (by name),
            // mirroring the name-keyed aggregation used for states above —
            // different projects can have differently-populated bundles for
            // a same-named field.
            const seenNames = new Set(existing.values.map((v) => v.name.toLowerCase()));
            for (const val of cf.bundle.values) {
              if (!seenNames.has(val.name.toLowerCase())) {
                existing.values.push({ id: val.id, name: val.name, ordinal: val.ordinal });
                seenNames.add(val.name.toLowerCase());
              }
            }
          }
        }
      }
    }
  }

  return {
    states: Array.from(allStates.values()),
    groupableFields: Array.from(allGroupableFields.values()),
  };
}

/** @deprecated Use loadProjectCustomFields instead */
export async function loadProjectStates(
  host: EmbeddableWidgetAPI,
  projectIds: string[]
): Promise<StatusOrderItem[]> {
  return (await loadProjectCustomFields(host, projectIds)).states;
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
      `[progress-tracking] Activity page for issue ${issueId} has more entries beyond the first ${ACTIVITIES_PAGE_SIZE}. ` +
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

// ─── Helper: extract a group-by enum field's current value from an issue ────

/**
 * Reads the current value of the given enum field (matched case-insensitively
 * against either the field's technical name or its localizedName, same
 * matching rule as issues-progress's extractIssueTypeName) from an issue's
 * fields. Returns undefined when the field isn't present on the issue or has
 * no value set. Generalizes extractIssueTypeName to an arbitrary field name,
 * since grouping is no longer hardcoded to "Type".
 */
export function extractGroupFieldValue(issue: Issue, fieldName: string): string | undefined {
  const target = fieldName.toLowerCase();
  if (!target) return undefined;
  const field = issue.fields.find((f) => {
    const fld = f.projectCustomField?.field;
    return fld?.name?.toLowerCase() === target || fld?.localizedName?.toLowerCase() === target;
  });
  if (!field) return undefined;
  const val = field.value;
  if (Array.isArray(val)) return val[0]?.name;
  return (val as { name?: string } | null)?.name;
}

/**
 * Reads an issue's current State field value (id + name), used as a fallback
 * for issues that have never had a state-change activity — e.g. an issue
 * created directly into a state (bulk import/seed data) rather than via a
 * logged transition. Without this fallback, such an issue has no usable
 * timeline at all and renders as an empty bar (confirmed on real data: DEMO-1,
 * DEMO-8, both created straight into "Done" with zero recorded State
 * activity). Mirrors issue-state-history/resources.ts's extractCurrentState.
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
