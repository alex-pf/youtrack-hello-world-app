const http = require('@jetbrains/youtrack-scripting-api/http');

// waibee exposes an OpenAI-compatible chat completions endpoint.
const WAIBEE_PATH = '/v1/chat/completions';
const DEFAULT_MODEL = 'waibee-1';

function formatIssuesForPrompt(issues) {
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
    return '### ' + issue.idReadable + ' ' + issue.summary +
      (fields ? '\n' + fields : '') +
      (issue.description ? '\n' + issue.description : '');
  }).join('\n\n');
}

function buildWaibeeRequestBody(issues, prompt, model) {
  return JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: formatIssuesForPrompt(issues) }
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

        const connection = new http.Connection(endpoint);
        connection.addHeader('Content-Type', 'application/json');
        connection.addHeader('Authorization', 'Bearer ' + apiKey);

        const response = connection.postSync(
          WAIBEE_PATH,
          null,
          buildWaibeeRequestBody(issues, prompt, ctx.settings.waibeeModel)
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
