#!/usr/bin/env node
// Daytime cron entry — checks the plan saved by plan.mjs for due actions and
// executes them against YouTrack. Run every 15-60 min during working hours
// (the AI-chosen action times inside the plan provide the actual pacing —
// this cron cadence just controls how promptly a due action is noticed).
//
// Usage:
//   node --env-file=.env.local scripts/data-gen/run.mjs [--dry-run]
//
// --dry-run prints what WOULD happen (including a would-be re-plan) without
// calling the YouTrack API or writing state.json. Always run this once
// before the first real cron invocation on a fresh VPS — see README.md.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadProjectStructure, createIssue, transitionIssue, setEstimatedDate, ensureTag, addTagToIssue} from './lib/youtrack.mjs';
import {loadState, saveState} from './lib/state.mjs';
import {runPlanning, structureHash} from './lib/plan-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const dryRun = process.argv.includes('--dry-run');

function isWorkingMoment(now) {
  const {workingDaysOnly, workingHours} = config.schedule;
  const local = new Date(new Date(now).toLocaleString('en-US', {timeZone: config.schedule.timezone}));
  const day = local.getDay(); // 0 = Sunday, 6 = Saturday
  if (workingDaysOnly && (day === 0 || day === 6)) return false;
  const hour = local.getHours();
  return hour >= workingHours.startHour && hour < workingHours.endHour;
}

async function executeAction(state, action) {
  if (action.type === 'create_issue') {
    if (dryRun) {
      console.log(`[dry-run] would create issue ${action.syntheticId} (type=${action.issueType})`);
      return;
    }
    const structure = await loadProjectStructure(config.youtrack.projectId);
    const startStatus = structure.states[0]?.name;
    if (!startStatus) throw new Error('No workflow states found on project — cannot pick a start status');

    const summary = `${config.synthetic.summaryPrefix} ${action.syntheticId}`;
    const idReadable = await createIssue(config.youtrack.projectId, {
      summary,
      fields: {[config.target.groupByField]: action.issueType, State: startStatus},
    });
    const tagId = await ensureTag(config.synthetic.tag);
    await addTagToIssue(idReadable, tagId);

    state.issues.push({
      syntheticId: action.syntheticId,
      idReadable,
      type: action.issueType,
      createdAtMs: action.runAtMs,
      currentStatus: startStatus,
    });
    console.log(`Created ${idReadable} (${action.syntheticId}, type=${action.issueType})`);
    return;
  }

  const issue = state.issues.find(i => i.syntheticId === action.syntheticId);
  if (!issue) {
    throw new Error(`No known issue for syntheticId "${action.syntheticId}" — was it created in an earlier, un-executed plan?`);
  }

  if (action.type === 'transition') {
    if (dryRun) {
      console.log(`[dry-run] would transition ${issue.idReadable} -> ${action.targetStatus}`);
      return;
    }
    await transitionIssue(config.youtrack.projectId, issue.idReadable, action.targetStatus);
    issue.currentStatus = action.targetStatus;
    console.log(`Transitioned ${issue.idReadable} -> ${action.targetStatus}`);
    return;
  }

  if (action.type === 'set_estimated_date') {
    const dateMs = action.runAtMs + (action.estimatedDateOffsetDays ?? 0) * 86400000;
    if (dryRun) {
      console.log(`[dry-run] would set estimated date on ${issue.idReadable} to ${new Date(dateMs).toISOString()}`);
      return;
    }
    await setEstimatedDate(config.youtrack.projectId, issue.idReadable, dateMs);
    console.log(`Set estimated date on ${issue.idReadable} to ${new Date(dateMs).toISOString()}`);
    return;
  }

  throw new Error(`Unknown action type "${action.type}"`);
}

async function main() {
  const now = Date.now();

  if (!isWorkingMoment(now)) {
    console.log('Outside working days/hours — nothing to do.');
    return;
  }

  let state = loadState();

  if (!state.plan) {
    console.log('No plan found — run plan.mjs first (nightly cron entry).');
    return;
  }

  // Structural drift check — re-plan the remainder of the day if the
  // project's statuses/fields changed since the plan was generated.
  const currentStructure = await loadProjectStructure(config.youtrack.projectId);
  const currentHash = structureHash(currentStructure);
  if (currentHash !== state.plan.structureHash) {
    console.log(`Project structure changed (${state.plan.structureHash} -> ${currentHash})`);
    if (dryRun) {
      console.log('[dry-run] would re-plan the remainder of the day here — skipping actual re-plan call.');
    } else {
      await runPlanning({config, isPartialDay: true});
      state = loadState();
    }
  }

  const due = state.plan.actions.filter(a => !a.executed && a.runAtMs <= now);
  if (due.length === 0) {
    console.log('No due actions.');
    return;
  }

  for (const action of due) {
    try {
      await executeAction(state, action);
      if (!dryRun) action.executed = true;
    } catch (e) {
      console.error(`Action failed (${action.type} ${action.syntheticId}): ${e.message}`);
      if (!dryRun) {
        action.executed = true;
        action.error = e.message;
      }
    }
  }

  if (!dryRun) saveState(state);
}

await main();
