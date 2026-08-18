import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state.json');

// Runtime state persisted between cron invocations (gitignored — see
// docs/PROGRESS_TRACKING_SPEC.md is unrelated; see scripts/data-gen/README.md
// for the deployment story this file supports).
//
// Shape:
// {
//   issues: [{ syntheticId, idReadable, type, createdAtMs, currentStatus }],
//   plan: {
//     generatedAtMs: number,           // "now" the plan's relative offsets are anchored to
//     structureHash: string,           // hash of loadProjectStructure() at generation time
//     actions: [{
//       syntheticId, type, issueType?, targetStatus?, estimatedDateOffsetDays?,
//       runAtMs: number,               // generatedAtMs + offset, resolved once at generation time
//       executed: boolean,
//     }],
//   } | null,
// }

const EMPTY_STATE = {issues: [], plan: null};

export function loadState() {
  if (!existsSync(STATE_PATH)) return structuredClone(EMPTY_STATE);
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}
