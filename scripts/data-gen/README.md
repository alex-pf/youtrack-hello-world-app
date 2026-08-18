# Synthetic data generator

Populates a **test** YouTrack Cloud project with realistic-looking issues and
status history, so the Progress Tracking widget (and others) have something
better than an empty/thin project to render against.

Because the YouTrack REST API cannot backdate activity history (issue
creation and every field/status change always get "now" as their timestamp —
see the research that led to this design), the only way to get a believable
lead-time distribution is to let history accumulate in **real time**, on a
schedule, over days/weeks. This is not a one-shot script — it's meant to run
unattended on a VPS via cron for as long as you want the dataset to keep
growing.

## How it works

Two cron jobs, two responsibilities:

1. **`plan.mjs`** (run once a night, e.g. 00:30) — reads the target project's
   current statuses/fields from YouTrack, reads `config.json`'s targets
   (issues/week, target p50/p80 lead time per type), asks Claude
   (`claude-haiku-4-5` by default — cheap, only needs to emit structured
   JSON) to produce today's action plan: which issues to create, which
   existing synthetic issues to transition to which status, at what times.
   Saves the plan to `state.json`, anchored to the moment it ran (every
   action in the plan is a relative offset — `+N days/hours/minutes` — not
   an absolute timestamp the AI had to compute itself).

2. **`run.mjs`** (run every 15-60 min during working hours, e.g. via cron
   `*/30 9-19 * * 1-5`) — checks the plan saved by `plan.mjs` for actions
   whose resolved time has arrived and haven't run yet, and executes them
   against the real YouTrack REST API (create issue / transition status /
   set Estimated Date). Before executing anything, it re-fetches the
   project's structure and compares it against the hash stored with the
   plan — if a status or field changed since the plan was generated (someone
   edited the workflow), it calls back into the planner for a fresh plan
   covering the rest of the day instead of blindly executing a stale one.

All state (which synthetic issues exist, their current status, today's plan
and which parts of it have run) lives in `state.json`, gitignored — it's
local machine state for the VPS, not something to commit.

## Safety / marking

Every issue this script creates gets:
- `[synthetic]` prefixed to its summary
- a `synthetic-data` tag

Both are configurable in `config.json` → `synthetic`. The script only ever
*acts on* issues it created itself (tracked in `state.json` by a symbolic
`syntheticId`) — it never touches arbitrary issues in the project. To bulk
clean up later, search `tag: synthetic-data` in YouTrack and delete.

**Point this only at a test/sandbox YouTrack instance.** There is nothing in
the script that checks this for you.

## Setup

```bash
cd /path/to/youtrack-hello-world-app
npm install
cp scripts/data-gen/.env.local.example scripts/data-gen/.env.local
# edit scripts/data-gen/.env.local: YOUTRACK_BASE_URL, YOUTRACK_TOKEN, ANTHROPIC_API_KEY
```

Edit `scripts/data-gen/config.json`:
- `youtrack.projectId` — the internal id of your test project (e.g. `0-0`,
  visible in the project's admin URL).
- `target.groupByField` and `target.leadTime` — must match real field/type
  names in your project (e.g. if your `Type` field has values `Bug`/
  `Feature`/`Task`, key `leadTime` by exactly those names).
- `schedule` — working days/hours and how many actions per day the AI should
  aim for. The *cron* cadence below controls how often `run.mjs` checks for
  due actions, not how many actions happen — that's `actionsPerDayRange` +
  the AI's own scheduling within working hours.

## Dry run first — always

Before touching cron, verify against your real project data without writing
anything:

```bash
npm run data-gen:plan          # generates a real plan (does write state.json — only local state, no YouTrack calls)
npm run data-gen:run:dry       # prints what WOULD happen; no YouTrack API calls, no state.json writes
```

Read the dry-run output. Check the invented issue types, target statuses,
and timing make sense against your actual project before ever running
`data-gen:run` for real.

## Cron setup (Ubuntu VPS)

```bash
crontab -e
```

```cron
# Nightly plan — once, off-peak
30 0 * * * cd /path/to/youtrack-hello-world-app && /usr/bin/node --env-file=scripts/data-gen/.env.local scripts/data-gen/plan.mjs >> /var/log/data-gen.log 2>&1

# Daytime executor — every 30 min, cron itself also gates to weekdays;
# run.mjs additionally checks config.json's working-hours window so a stray
# invocation outside 9-19 is a no-op rather than an error.
*/30 8-20 * * 1-5 cd /path/to/youtrack-hello-world-app && /usr/bin/node --env-file=scripts/data-gen/.env.local scripts/data-gen/run.mjs >> /var/log/data-gen.log 2>&1
```

(A systemd timer works the same way if you prefer that over cron — two
`.service` units calling the same two npm scripts, triggered by two
`.timer` units with `OnCalendar=` matching the schedules above.)

## Growing / topping up the dataset

Nothing to do — leave the cron jobs running. Each night's plan naturally
builds on whatever synthetic issues are already open (tracked in
`state.json`), so the dataset keeps accumulating history in the background.
To pause, comment out the crontab lines; to stop and start fresh, delete
`scripts/data-gen/state.json` (this forgets which issues were created, so
old synthetic issues in YouTrack become "orphaned" from the script's
perspective — clean them up via the `synthetic-data` tag first if you want a
truly clean slate).

## Files

| File | Purpose |
|---|---|
| `config.json` | Non-secret config: project id, targets, schedule, AI model |
| `.env.local` (gitignored) | Secrets: YouTrack token, Anthropic API key |
| `state.json` (gitignored) | Runtime state: known synthetic issues + today's plan |
| `lib/youtrack.mjs` | Minimal YouTrack REST client (structure discovery, create/transition/tag/set-date) |
| `lib/ai-plan.mjs` | Builds the planning prompt, calls Claude for a structured JSON plan |
| `lib/plan-core.mjs` | Shared planning logic used by both `plan.mjs` and `run.mjs`'s drift-triggered re-plan |
| `lib/state.mjs` | Load/save `state.json` |
| `plan.mjs` | Nightly cron entry point |
| `run.mjs` | Daytime cron entry point (`--dry-run` supported) |

## Known limitations

- The "start status" for a newly created issue is assumed to be the first
  status YouTrack's API happens to return for the project's State field —
  there's no reliable way to ask YouTrack which status is the workflow's
  entry point. Verify this matches your actual first status (e.g. "ToDo")
  after the first dry run; if not, this is the one thing you'd need to patch
  in `run.mjs`'s `executeAction` (`create_issue` branch).
- The AI plan is advisory, not guaranteed-precise — it aims for the
  configured p50/p80 targets per type but won't hit them exactly; treat the
  resulting dataset as "plausible", not "statistically exact".
- If `ANTHROPIC_API_KEY` or `YOUTRACK_TOKEN` are wrong/expired, `plan.mjs`
  and `run.mjs` fail loudly (non-zero exit, error on stderr) — check
  `/var/log/data-gen.log` if scheduled runs go quiet.
