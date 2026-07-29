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
): Promise<AskAiResponse> {
  return await host.fetchApp<AskAiResponse>('ask-ai/ask', {
    method: 'POST',
    body: {issues, prompt}
  });
}

/**
 * host.fetchYouTrack/fetchApp reject with whatever shape the host runtime
 * gives them — sometimes an Error, sometimes the parsed error response body
 * as a plain object. Normalize both into a readable string instead of
 * letting `String(e)` collapse an object into "[object Object]".
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const data = (e as Error & {data?: unknown}).data;
    if (data && typeof data === 'object' && 'error' in data && typeof (data as {error: unknown}).error === 'string') {
      return (data as {error: string}).error;
    }
    return e.message || String(e);
  }
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.message === 'string') return obj.message;
    try {
      return JSON.stringify(obj);
    } catch {
      // fall through
    }
  }
  return String(e);
}

/** Best-effort full dump of a caught value, for the debug panel. */
export function dumpError(e: unknown): string {
  if (e instanceof Error) {
    const data = (e as Error & {data?: unknown, status?: unknown}).data;
    const status = (e as Error & {status?: unknown}).status;
    return JSON.stringify({name: e.name, message: e.message, status, data}, null, 2);
  }
  try {
    return JSON.stringify(e, null, 2);
  } catch {
    return String(e);
  }
}
