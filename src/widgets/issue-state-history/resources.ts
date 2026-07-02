import type { EmbeddableWidgetAPI } from '../../../@types/globals';
import type {
  ProjectInfo,
  ProjectCustomFieldInfo,
  StatusOrderItem,
} from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_PROJECTS = 200;

// ─── Field selector strings ──────────────────────────────────────────────────

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
