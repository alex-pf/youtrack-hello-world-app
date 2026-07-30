const http = require('@jetbrains/youtrack-scripting-api/http');

// waibee exposes an OpenAI-compatible chat completions endpoint.
const WAIBEE_PATH = '/v1/chat/completions';
// waibee requires model ids in "<provider>/<model>" form; "waibee/auto" picks one.
const DEFAULT_MODEL = 'waibee/auto';

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

        // A trailing slash in the setting would produce "host//v1/..." — some
        // proxies 404 on the double slash, so normalize it away.
        const connection = new http.Connection(String(endpoint).replace(/\/+$/, ''));
        connection.addHeader('Content-Type', 'application/json');
        // Secret settings arrive as an opaque reference whose toString() is a
        // mask ("*****"), so building the header by hand sends the mask and
        // gets a 401. bearerAuth resolves the real secret inside the runtime.
        connection.bearerAuth(apiKey);

        const response = connection.postSync(
          WAIBEE_PATH,
          null,
          buildWaibeeRequestBody(issues, prompt, ctx.settings.waibeeModel, history)
        );

        if (!response.isSuccess) {
          ctx.response.code = 502;
          ctx.response.json({ error: 'waibee request failed: ' + response.code + ' ' + response.body });
          return;
        }

        const markdown = extractMarkdown(response.json());
        ctx.response.json({ markdown: markdown });
      }
    }
  ]
};
