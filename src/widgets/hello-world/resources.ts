import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {Issue} from './types';

const PROJECT_CUSTOM_FIELD_FIELDS = 'id,bundle(id),field(id,name,localizedName,fieldType(id,valueType))';
const ISSUE_FIELD_VALUE_FIELDS = 'id,name,localizedName,login,avatarUrl,presentation,minutes,color(id,foreground,background)';
const ISSUE_FIELD_FIELDS = `id,value(${ISSUE_FIELD_VALUE_FIELDS}),projectCustomField(${PROJECT_CUSTOM_FIELD_FIELDS})`;
const ISSUE_FIELDS = `id,idReadable,summary,resolved,fields(${ISSUE_FIELD_FIELDS})`;

export const ISSUES_PACK_SIZE = 50;

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
