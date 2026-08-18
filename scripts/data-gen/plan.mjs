#!/usr/bin/env node
// Nightly cron entry — generates the day's action plan and saves it to
// state.json. Run once per night (e.g. 00:30 local time) via cron/systemd.
//
// Usage:
//   node --env-file=.env.local scripts/data-gen/plan.mjs
//
// See scripts/data-gen/README.md for full deployment instructions.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runPlanning} from './lib/plan-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const plan = await runPlanning({config});

console.log(`Plan generated at ${new Date(plan.generatedAtMs).toISOString()} (structure hash ${plan.structureHash})`);
console.log(`Notes: ${plan.notes}`);
console.log(`Actions (${plan.actions.length}):`);
for (const a of plan.actions) {
  console.log(`  [${new Date(a.runAtMs).toLocaleString()}] ${a.type} ${a.syntheticId}${a.issueType ? ` type=${a.issueType}` : ''}${a.targetStatus ? ` -> ${a.targetStatus}` : ''}`);
}
