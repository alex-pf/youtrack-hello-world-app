import {createHash} from 'node:crypto';
import {loadProjectStructure} from './youtrack.mjs';
import {generatePlan} from './ai-plan.mjs';
import {loadState, saveState} from './state.mjs';

export function structureHash(structure) {
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex').slice(0, 16);
}

function resolveOffsetMs(action) {
  return (action.offsetDays ?? 0) * 86400000 + (action.offsetHours ?? 0) * 3600000 + (action.offsetMinutes ?? 0) * 60000;
}

/**
 * Fetches the current YouTrack project structure, asks the AI for today's
 * (or the remaining day's) action plan, resolves every action's relative
 * offset into an absolute runAtMs anchored to "now", and persists the plan
 * (plus a structure hash for drift detection) to state.json.
 *
 * @param isPartialDay - true when this is a re-plan triggered by run.mjs
 *   detecting that the project structure changed mid-day (see README).
 */
export async function runPlanning({config, isPartialDay = false} = {}) {
  const state = loadState();
  const structure = await loadProjectStructure(config.youtrack.projectId);
  const hash = structureHash(structure);

  const resolvedStateNames = new Set(
    structure.states.filter(s => s.isResolved).map(s => s.name)
  );
  const openIssues = state.issues.filter(i => !resolvedStateNames.has(i.currentStatus));

  const now = new Date();
  const dayLabel = now.toLocaleDateString('ru-RU', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});

  const plan = await generatePlan({config, structure, openIssues, dayLabel, isPartialDay});

  const generatedAtMs = Date.now();
  const actions = plan.actions.map(a => ({
    ...a,
    runAtMs: generatedAtMs + resolveOffsetMs(a),
    executed: false,
  }));

  state.plan = {generatedAtMs, structureHash: hash, notes: plan.notes, actions};
  saveState(state);

  return state.plan;
}
