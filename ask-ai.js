const http = require('@jetbrains/youtrack-scripting-api/http');

// waibee exposes an OpenAI-compatible chat completions endpoint.
const WAIBEE_PATH = '/v1/chat/completions';
// waibee requires model ids in "<provider>/<model>" form; "waibee/auto" picks one.
const DEFAULT_MODEL = 'waibee/auto';

// Complex analytical prompts can take waibee well past YouTrack's own
// gateway timeout on a synchronous request (observed: 504 "Service
// Unavailable" from YouTrack itself, not from waibee). ask-ai/ask schedules
// the call as an async HTTP request instead of waiting for it — the widget
// gets a requestId immediately and polls ask-ai/result until the async
// response handler below has written a status.
//
// Requests are tracked in a single JSON-string global storage property
// (extension properties are statically typed/named, not a free-form KV
// store — see entity-extensions.json) and pruned by age on every write so
// the property doesn't grow unbounded.
const REQUEST_TTL_MS = 30 * 60 * 1000;

function loadRequests(ctx) {
  const raw = ctx.globalStorage.extensionProperties.aiRequests;
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function saveRequests(ctx, requests) {
  const now = Date.now();
  const pruned = {};
  Object.keys(requests).forEach(function (id) {
    const entry = requests[id];
    if (entry && now - (entry.updatedAt || 0) < REQUEST_TTL_MS) {
      pruned[id] = entry;
    }
  });
  ctx.globalStorage.extensionProperties.aiRequests = JSON.stringify(pruned);
}

function makeRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function formatIssuesForPrompt(issues, history) {
  history = history || {};
  return issues.map(function (issue) {
    const fields = (issue.fields || [])
      .map(function (f) {
        const def = f.projectCustomField && f.projectCustomField.field;
        const label = def ? (def.localizedName || def.name) : null;
        const value = f.value;
        const rendered = value == null
          ? ''
          : (value.presentation || value.fullName || value.name || value.login || value);
        return label ? label + ': ' + rendered : null;
      })
      .filter(Boolean)
      .join(', ');
    const historyText = history[issue.idReadable];
    return '### ' + issue.idReadable + ' ' + issue.summary +
      (fields ? '\n' + fields : '') +
      (issue.description ? '\n' + issue.description : '') +
      (historyText ? '\nИстория:\n' + historyText : '');
  }).join('\n\n');
}

function buildWaibeeRequestBody(issues, prompt, model, history) {
  return JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: formatIssuesForPrompt(issues, history) }
    ]
  });
}

function extractMarkdown(waibeeResponseJson) {
  const choice = (waibeeResponseJson.choices || [])[0];
  return (choice && choice.message && choice.message.content) || '';
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'global',
      method: 'POST',
      path: 'ask',
      permissions: ['READ_ISSUE'],
      handle: function (ctx) {
        const body = ctx.request.json();
        const issues = body.issues || [];
        const prompt = body.prompt || '';
        const history = body.history || {};

        if (!prompt) {
          ctx.response.code = 400;
          ctx.response.json({ error: 'prompt is required' });
          return;
        }

        const apiKey = ctx.settings.waibeeApiKey;
        const endpoint = ctx.settings.waibeeEndpoint;

        if (!apiKey || !endpoint) {
          ctx.response.code = 500;
          ctx.response.json({ error: 'waibee is not configured. Set waibeeEndpoint and waibeeApiKey in the app settings.' });
          return;
        }

        const requestId = makeRequestId();
        const requests = loadRequests(ctx);
        requests[requestId] = { status: 'pending', updatedAt: Date.now() };
        saveRequests(ctx, requests);

        // A trailing slash in the setting would produce "host//v1/..." — some
        // proxies 404 on the double slash, so normalize it away.
        const connection = new http.Connection(String(endpoint).replace(/\/+$/, ''));
        connection.addHeader('Content-Type', 'application/json');
        // Secret settings arrive as an opaque reference whose toString() is a
        // mask ("*****"), so building the header by hand sends the mask and
        // gets a 401. bearerAuth resolves the real secret inside the runtime.
        connection.bearerAuth(apiKey);

        // ctx.store/ctx.load carry state into the async response handler,
        // which runs in a new transaction after this one completes.
        ctx.store('requestId', requestId);
        connection.postAsync(
          WAIBEE_PATH,
          null,
          buildWaibeeRequestBody(issues, prompt, ctx.settings.waibeeModel, history),
          'onWaibeeResponse'
        );

        ctx.response.json({ requestId: requestId });
      }
    },
    {
      scope: 'global',
      method: 'GET',
      path: 'result',
      permissions: ['READ_ISSUE'],
      handle: function (ctx) {
        const requestId = ctx.request.getParameter('requestId');
        if (!requestId) {
          ctx.response.code = 400;
          ctx.response.json({ error: 'requestId is required' });
          return;
        }

        const requests = loadRequests(ctx);
        const entry = requests[requestId];

        if (!entry) {
          ctx.response.code = 404;
          ctx.response.json({ error: 'unknown or expired requestId' });
          return;
        }

        ctx.response.json(entry);
      }
    }
  ],
  asyncFunctions: {
    onWaibeeResponse: function (ctx) {
      const requestId = ctx.load('requestId');
      const requests = loadRequests(ctx);

      if (!ctx.response.isSuccess) {
        requests[requestId] = {
          status: 'error',
          error: 'waibee request failed: ' + ctx.response.code + ' ' + ctx.response.body,
          updatedAt: Date.now()
        };
        saveRequests(ctx, requests);
        return;
      }

      let markdown = '';
      try {
        markdown = extractMarkdown(ctx.response.json());
      } catch (e) {
        requests[requestId] = {
          status: 'error',
          error: 'failed to parse waibee response: ' + e,
          updatedAt: Date.now()
        };
        saveRequests(ctx, requests);
        return;
      }

      requests[requestId] = { status: 'done', markdown: markdown, updatedAt: Date.now() };
      saveRequests(ctx, requests);
    }
  }
};
