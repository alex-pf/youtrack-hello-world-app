import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {Issue} from './types';

const PROJECT_CUSTOM_FIELD_FIELDS = 'id,bundle(id),field(id,name,localizedName,fieldType(id,valueType))';
const ISSUE_FIELD_VALUE_FIELDS = 'id,name,localizedName,login,avatarUrl,presentation,minutes,color(id,foreground,background)';
const ISSUE_FIELD_FIELDS = `id,value(${ISSUE_FIELD_VALUE_FIELDS}),projectCustomField(${PROJECT_CUSTOM_FIELD_FIELDS})`;
const ISSUE_FIELDS = `id,idReadable,summary,resolved,fields(${ISSUE_FIELD_FIELDS})`;

export const ISSUES_PACK_SIZE = 50;

export async function loadIssues(
  host: EmbeddableWidgetAPI,
  query: string,
  skip = 0
): Promise<Issue[]> {
  const encodedQuery = encodeURIComponent(query);
  return await host.fetchYouTrack<Issue[]>(
    `api/issues?fields=${ISSUE_FIELDS}&query=${encodedQuery}&$top=${ISSUES_PACK_SIZE}&$skip=${skip}`
  );
}

export async function loadIssuesCount(
  host: EmbeddableWidgetAPI,
  query: string
): Promise<number> {
  const result = await host.fetchYouTrack<{count: number}>(
    'api/issuesGetter/count?fields=count',
    {
      method: 'POST',
      body: {
        folder: null,
        query: query || null
      }
    }
  );
  return result?.count ?? 0;
}
