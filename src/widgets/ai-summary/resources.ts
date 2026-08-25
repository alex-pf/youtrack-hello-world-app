import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import type {
  Issue,
  AskAiStartResponse,
  AskAiResultResponse,
  IssueActivityItem,
  ActivityPage,
  ActivityValue,
  HistoryDigest
} from './types';

const ISSUE_FIELD_VALUE_FIELDS = 'name,login,fullName,presentation';
const ISSUE_FIELD_FIELDS = `value(${ISSUE_FIELD_VALUE_FIELDS}),projectCustomField(field(name,localizedName))`;
// trimmedIssues (rather than issues) caps the number of linked issues YouTrack
// returns per link type, so a heavily-linked issue can't blow up the response.
const ISSUE_LINK_FIELDS = 'direction,linkType(name,localizedName,sourceToTarget,targetToSource),trimmedIssues(idReadable,summary)';
const ISSUE_FIELDS = `id,idReadable,summary,description,fields(${ISSUE_FIELD_FIELDS}),links(${ISSUE_LINK_FIELDS})`;

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

// Complex analytical prompts can take waibee longer than YouTrack's own
// gateway timeout on a synchronous request. ask-ai/ask schedules the waibee
// call as an async HTTP request on the backend and hands back a requestId
// immediately; the actual answer is fetched by polling ask-ai/result.
function startAskAi(
  host: EmbeddableWidgetAPI,
  issues: Issue[],
  prompt: string,
  history: HistoryDigest
): Promise<AskAiStartResponse> {
  return host.fetchApp<AskAiStartResponse>('ask-ai/ask', {
    method: 'POST',
    body: {issues, prompt, history}
  });
}

function pollAskAiResult(
  host: EmbeddableWidgetAPI,
  requestId: string
): Promise<AskAiResultResponse> {
  return host.fetchApp<AskAiResultResponse>('ask-ai/result', {
    query: {requestId}
  });
}

const POLL_INTERVAL_MS = 2500;
// waibee's own stated thinking-time budget is 10 minutes; give it a couple
// extra minutes of slack for network/queueing before giving up client-side.
const POLL_TIMEOUT_MS = 12 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface AskAiOptions {
  /** Called on every poll tick with elapsed time, for a "Ждём ответ..." status message. */
  onTick?: (elapsedMs: number) => void;
}

export async function askAi(
  host: EmbeddableWidgetAPI,
  issues: Issue[],
  prompt: string,
  history: HistoryDigest,
  options: AskAiOptions = {}
): Promise<AskAiResultResponse> {
  const start = await startAskAi(host, issues, prompt, history);
  if (start.error) {
    return {status: 'error', error: start.error};
  }
  if (!start.requestId) {
    return {status: 'error', error: 'backend did not return a requestId'};
  }

  const requestId = start.requestId;
  const startedAt = Date.now();

  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > POLL_TIMEOUT_MS) {
      return {status: 'error', error: `waibee did not respond within ${Math.round(POLL_TIMEOUT_MS / 1000)}s`};
    }

    await sleep(POLL_INTERVAL_MS);
    options.onTick?.(Date.now() - startedAt);

    const result = await pollAskAiResult(host, requestId);
    if (result.status !== 'pending') {
      return result;
    }
  }
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

// ─── Issue history ───────────────────────────────────────────────────────────
//
// Design note: rather than shipping raw activity JSON to waibee (expensive in
// tokens and full of noise — author ids, raw category types, unrelated
// fields), activities are compacted client-side into a short chronological
// digest per issue (see buildHistoryDigest). This keeps the prompt small and
// deterministic regardless of how verbose an issue's history is.

const ACTIVITY_ITEM_FIELDS =
  'timestamp,author(login,fullName,name),category(id),field(name,localizedName),' +
  'added(name,presentation,login,fullName,text,value),' +
  'removed(name,presentation,login,fullName,text,value)';
const ACTIVITY_FIELDS = `activities(${ACTIVITY_ITEM_FIELDS}),cursor,hasAfter`;
const ACTIVITIES_PAGE_SIZE = 1000;

// CustomFieldCategory/IssueResolvedCategory cover state & field transitions;
// CommentsCategory is opt-in via the "Включить комментарии" setting since
// comment threads can be long and aren't always relevant to the prompt.
const ACTIVITY_CATEGORIES_BASE = 'CustomFieldCategory,IssueResolvedCategory';
const ACTIVITY_CATEGORIES_WITH_COMMENTS = `${ACTIVITY_CATEGORIES_BASE},CommentsCategory`;

// How many issues' activity histories to fetch in parallel. High enough to
// meaningfully cut wall-clock time vs. the fully-sequential approach used by
// the issue-state-history widget, low enough to stay gentle on YouTrack's
// rate limits for a user-triggered ("Обновить" click) request.
const HISTORY_CONCURRENCY = 5;
const HISTORY_COMMENT_SNIPPET_LENGTH = 200;

async function loadIssueActivities(
  host: EmbeddableWidgetAPI,
  issueId: string,
  categories: string
): Promise<IssueActivityItem[]> {
  const page = await host.fetchYouTrack<ActivityPage>(`issues/${issueId}/activitiesPage`, {
    query: {
      fields: ACTIVITY_FIELDS,
      categories,
      $top: String(ACTIVITIES_PAGE_SIZE)
    }
  });
  return page?.activities ?? [];
}

function formatActivityValue(value: ActivityValue | ActivityValue[] | null | undefined): string {
  if (value == null) return '—';
  if (Array.isArray(value)) {
    return value.length ? value.map(formatActivityValue).join(', ') : '—';
  }
  return value.presentation
    || value.fullName
    || value.name
    || value.login
    || value.text
    || (value.value != null ? String(value.value) : '')
    || '—';
}

function formatActivityDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function formatAuthor(activity: IssueActivityItem): string {
  return activity.author?.fullName || activity.author?.name || activity.author?.login || 'unknown';
}

/** Turns raw activities into a compact chronological text digest for the AI prompt. */
export function buildHistoryDigest(activities: IssueActivityItem[]): string {
  const lines = [...activities]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(activity => {
      const date = formatActivityDate(activity.timestamp);
      const author = formatAuthor(activity);

      if (activity.category?.id === 'CommentsCategory') {
        const added = Array.isArray(activity.added) ? activity.added[0] : activity.added;
        const text = added?.text;
        if (!text) return null;
        const snippet = text.length > HISTORY_COMMENT_SNIPPET_LENGTH
          ? text.slice(0, HISTORY_COMMENT_SNIPPET_LENGTH) + '…'
          : text;
        return `${date} комментарий (${author}): ${snippet}`;
      }

      const field = activity.field?.localizedName
        || activity.field?.name
        || (activity.category?.id === 'IssueResolvedCategory' ? 'Resolved' : null);
      if (!field) return null;

      const from = formatActivityValue(activity.removed);
      const to = formatActivityValue(activity.added);
      return `${date} ${field}: ${from} → ${to} (${author})`;
    })
    .filter((line): line is string => Boolean(line));

  return lines.length ? lines.join('\n') : '(история изменений отсутствует)';
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker)
  );
  return results;
}

export async function loadIssuesHistory(
  host: EmbeddableWidgetAPI,
  issues: Issue[],
  includeComments: boolean
): Promise<HistoryDigest> {
  const categories = includeComments ? ACTIVITY_CATEGORIES_WITH_COMMENTS : ACTIVITY_CATEGORIES_BASE;

  const entries = await mapWithConcurrency(issues, HISTORY_CONCURRENCY, async (issue) => {
    try {
      const activities = await loadIssueActivities(host, issue.id, categories);
      return [issue.idReadable, buildHistoryDigest(activities)] as const;
    } catch (e) {
      return [issue.idReadable, `(не удалось загрузить историю: ${describeError(e)})`] as const;
    }
  });

  return Object.fromEntries(entries);
}
