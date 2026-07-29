import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {Issue, AskAiResponse} from './types';

const ISSUE_FIELD_VALUE_FIELDS = 'name,login,fullName,presentation';
const ISSUE_FIELD_FIELDS = `value(${ISSUE_FIELD_VALUE_FIELDS}),projectCustomField(field(name,localizedName))`;
const ISSUE_FIELDS = `idReadable,summary,description,fields(${ISSUE_FIELD_FIELDS})`;

const ISSUES_LIMIT = 50;

export async function loadIssues(
  host: EmbeddableWidgetAPI,
  search: string
): Promise<Issue[]> {
  return await host.fetchYouTrack<Issue[]>('issues', {
    query: {
      fields: ISSUE_FIELDS,
      query: search,
      $top: String(ISSUES_LIMIT)
    }
  });
}

export async function askAi(
  host: EmbeddableWidgetAPI,
  issues: Issue[],
  prompt: string
): Promise<string> {
  const response = await host.fetchApp<AskAiResponse>('ask-ai/ask', {
    method: 'POST',
    body: {issues, prompt}
  });
  return response.markdown || '';
}
