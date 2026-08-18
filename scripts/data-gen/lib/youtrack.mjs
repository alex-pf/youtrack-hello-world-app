// Minimal YouTrack REST client for the synthetic data generator.
// Uses a permanent token (YOUTRACK_TOKEN) — never bake it into config.json.

function baseUrl() {
  const url = process.env.YOUTRACK_BASE_URL;
  if (!url) throw new Error('YOUTRACK_BASE_URL is not set (see .env.local.example)');
  return url.replace(/\/$/, '');
}

function authHeaders() {
  const token = process.env.YOUTRACK_TOKEN;
  if (!token) throw new Error('YOUTRACK_TOKEN is not set (see .env.local.example)');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function request(path, {method = 'GET', query, body} = {}) {
  const url = new URL(`${baseUrl()}/api${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YouTrack ${method} ${url.pathname} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Project structure discovery ──────────────────────────────────────────

const CUSTOM_FIELD_FIELDS =
  'id,field(id,name,localizedName,fieldType(id,valueType)),' +
  'bundle(id,values(id,name,ordinal,isResolved))';

/**
 * Reads the project's custom fields and returns:
 *  - states: ordered list of workflow states (from the State-type field)
 *  - groupFields: map of enum-field name -> list of value names (Type, Priority, etc.)
 * Used by plan.mjs both to build the AI prompt and to detect structural drift
 * (via a stable JSON hash) before executing a previously-generated plan.
 */
export async function loadProjectStructure(projectId) {
  const fields = await request(`/admin/projects/${projectId}/customFields`, {
    query: {fields: CUSTOM_FIELD_FIELDS},
  });

  const states = [];
  const groupFields = {};

  for (const cf of fields) {
    const valueType = cf.field?.fieldType?.valueType?.toLowerCase() ?? '';
    const name = cf.field?.name ?? cf.field?.localizedName;
    if (!name || !cf.bundle?.values?.length) continue;

    if (valueType.includes('state')) {
      for (const v of cf.bundle.values) {
        if (!states.some(s => s.name === v.name)) states.push({name: v.name, isResolved: !!v.isResolved});
      }
    } else if (valueType.includes('enum')) {
      groupFields[name] = cf.bundle.values.map(v => v.name);
    }
  }

  return {states, groupFields};
}

// ─── Issue creation / mutation ─────────────────────────────────────────────

/**
 * Creates an issue with the given summary and initial custom field values.
 * `fields` is a map of field name -> value name (e.g. {Type: 'Bug', State: 'ToDo'}).
 * Returns the created issue's idReadable.
 */
export async function createIssue(projectId, {summary, fields}) {
  const projectCustomFields = await request(`/admin/projects/${projectId}/customFields`, {
    query: {fields: 'id,field(id,name),bundle(id,values(id,name))'},
  });

  const fieldPayload = [];
  for (const [fieldName, valueName] of Object.entries(fields ?? {})) {
    const cf = projectCustomFields.find(f => f.field?.name === fieldName);
    if (!cf) continue;
    const value = cf.bundle?.values?.find(v => v.name === valueName);
    if (!value) continue;
    fieldPayload.push({
      id: cf.id,
      name: fieldName,
      value: {id: value.id, name: value.name},
    });
  }

  const created = await request('/issues', {
    method: 'POST',
    query: {fields: 'id,idReadable'},
    body: {
      project: {id: projectId},
      summary,
      customFields: fieldPayload,
    },
  });
  return created.idReadable;
}

/**
 * Transitions an issue to a new State value by name.
 */
export async function transitionIssue(projectId, idReadable, stateName) {
  const projectCustomFields = await request(`/admin/projects/${projectId}/customFields`, {
    query: {fields: 'id,field(id,name,fieldType(valueType)),bundle(id,values(id,name))'},
  });
  const stateCf = projectCustomFields.find(f =>
    (f.field?.fieldType?.valueType ?? '').toLowerCase().includes('state')
  );
  if (!stateCf) throw new Error('No State-type custom field found on project');
  const value = stateCf.bundle?.values?.find(v => v.name === stateName);
  if (!value) throw new Error(`State "${stateName}" not found in project bundle`);

  await request(`/issues/${idReadable}`, {
    method: 'POST',
    query: {fields: 'id'},
    body: {
      customFields: [{id: stateCf.id, name: stateCf.field.name, value: {id: value.id, name: value.name}}],
    },
  });
}

// ─── Tagging (synthetic-data marker) ───────────────────────────────────────

let cachedTagId = null;

/**
 * Finds or creates a personal/shared tag with the given name and returns its
 * id. Cached for the lifetime of the process — call sites are the tag-once-
 * per-run.mjs-invocation path, not a hot loop.
 */
export async function ensureTag(name) {
  if (cachedTagId) return cachedTagId;
  const existing = await request('/tags', {query: {fields: 'id,name', query: name}});
  const match = (existing ?? []).find(t => t.name === name);
  if (match) {
    cachedTagId = match.id;
    return cachedTagId;
  }
  const created = await request('/tags', {
    method: 'POST',
    query: {fields: 'id,name'},
    body: {name},
  });
  cachedTagId = created.id;
  return cachedTagId;
}

export async function addTagToIssue(idReadable, tagId) {
  await request(`/issues/${idReadable}/tags`, {
    method: 'POST',
    query: {fields: 'id'},
    body: {id: tagId},
  });
}

/**
 * Sets the Estimated Date field (or equivalent) on an issue.
 */
export async function setEstimatedDate(projectId, idReadable, dateMs) {
  const projectCustomFields = await request(`/admin/projects/${projectId}/customFields`, {
    query: {fields: 'id,field(id,name)'},
  });
  const dateCf = projectCustomFields.find(f => {
    const n = (f.field?.name ?? '').toLowerCase();
    return n.includes('estimated') || n.includes('due date');
  });
  if (!dateCf) throw new Error('No Estimated Date field found on project');

  await request(`/issues/${idReadable}`, {
    method: 'POST',
    query: {fields: 'id'},
    body: {
      customFields: [{id: dateCf.id, name: dateCf.field.name, value: dateMs}],
    },
  });
}
