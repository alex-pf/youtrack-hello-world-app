import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {Issue, FieldColumnConfig} from './types';

const PROJECT_CUSTOM_FIELD_FIELDS = 'id,bundle(id),field(id,name,localizedName,fieldType(id,valueType))';
const ISSUE_FIELD_VALUE_FIELDS = 'id,name,localizedName,login,avatarUrl,presentation,minutes,color(id,foreground,background)';
const ISSUE_FIELD_FIELDS = `id,value(${ISSUE_FIELD_VALUE_FIELDS}),projectCustomField(${PROJECT_CUSTOM_FIELD_FIELDS})`;
const ISSUE_FIELDS = `id,idReadable,summary,resolved,created,updated,fields(${ISSUE_FIELD_FIELDS})`;

export const ISSUES_PACK_SIZE = 50;

/** Built-in fields that are always available */
export const BUILTIN_FIELDS: FieldColumnConfig[] = [
  {key: 'created', label: 'Дата создания', builtin: true},
  {key: 'updated', label: 'Дата обновления', builtin: true},
];

/**
 * Extract available custom field definitions from loaded issues.
 * Returns unique field configs based on field names found across all issues.
 */
export function extractAvailableFields(issues: Issue[]): FieldColumnConfig[] {
  const seen = new Set<string>();
  const fields: FieldColumnConfig[] = [];

  for (const issue of issues) {
    for (const f of issue.fields || []) {
      const fieldDef = f.projectCustomField?.field;
      if (!fieldDef) continue;
      const key = fieldDef.name;
      if (seen.has(key)) continue;
      // skip text-type fields (descriptions etc.)
      const valueType = fieldDef.fieldType?.valueType;
      if (valueType === 'text') continue;
      seen.add(key);
      fields.push({
        key,
        label: fieldDef.localizedName || fieldDef.name,
      });
    }
  }
  return fields;
}

export async function loadIssues(
  host: EmbeddableWidgetAPI,
  search: string,
  skip = 0
): Promise<Issue[]> {
  return await host.fetchYouTrack<Issue[]>('issues', {
    query: {
      fields: ISSUE_FIELDS,
      query: search,
      $top: String(ISSUES_PACK_SIZE),
      $skip: String(skip)
    }
  });
}

export async function loadIssuesCount(
  host: EmbeddableWidgetAPI,
  search: string
): Promise<number> {
  const result = await host.fetchYouTrack<{count: number}>(
    'issuesGetter/count',
    {
      method: 'POST',
      query: {
        fields: 'count'
      },
      body: {
        folder: null,
        query: search || null
      }
    }
  );
  return result?.count ?? 0;
}
