# Issues Progress Widget — Developer Documentation

## Overview

**Issues Progress** is an embeddable YouTrack dashboard widget that renders a Gantt-style horizontal bar chart showing how much time each issue has spent in each workflow status. It is built with React + D3.js and communicates with the YouTrack REST API through the `EmbeddableWidgetAPI` host bridge.

Primary use case: visualise flow efficiency (lead time, status dwell time, estimate drift) for a filtered set of issues.

---

## File Architecture

| File | Responsibility |
|------|---------------|
| `index.tsx` | Widget entry point — mounts the React root |
| `index.html` | Widget HTML shell |
| `app.tsx` | Root React component — lifecycle, data fetching, routing between Config / Chart / Debug views |
| `configuration.tsx` | Settings form component — all config fields, project/state/type loading |
| `gantt-chart.tsx` | Pure chart component — D3 SVG rendering, all visual elements |
| `activity-parser.ts` | Data transformation layer — raw activity items → chart-ready segments |
| `resources.ts` | YouTrack API layer — all `host.fetchYouTrack()` calls |
| `types.ts` | TypeScript type definitions + config serialization helpers |
| `gantt-chart.css` | Chart-specific styles (legend, tooltip, scroll wrapper) |
| `app.css` | App-level styles (loading, error, empty, debug panel) |
| `widget-settings.json` | JSON Schema for the stored config (used by YouTrack host) |
| `widget-icon.svg` | Widget icon shown in the dashboard palette |

---

## WidgetConfig — All Fields

Defined in `types.ts` as `WidgetConfig` (in-memory) and `StoredWidgetConfig` (persisted via `host.storeConfig`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | `string` | `''` | YouTrack search query string. Required — widget will not render without it. Example: `project: DEMO State: -Resolved`. |
| `title` | `string \| undefined` | `undefined` | Optional custom widget title shown in the dashboard header. Falls back to `"Issues Progress"`. |
| `projects` | `string[]` | `[]` | Array of YouTrack project internal IDs. Used only to load available statuses and issue types for the configuration form — not used to filter the query. |
| `statusOrder` | `StatusOrderItem[]` | `[]` | Ordered list of statuses to display as stacked bar segments. Each item has `{id, name, color?}`. The order controls the left-to-right stacking order of segments. If empty, all statuses found in activity history are used. |
| `ltEnabled` | `boolean` | `false` | Enables Lead Time threshold markers on the chart. |
| `ltSettings` | `LtSettings` | `{}` | Map of issue type name → `{lt50?, lt80?}` in days. Keys are exact issue type names (e.g., `"Bug"`, `"Feature"`). An empty string key `""` acts as a fallback for any type not explicitly listed. |
| `showEstimateDate` | `boolean` | `false` | When true, vertical tick marks are rendered on each bar at the x-position corresponding to when the estimate date was changed. |
| `showProjectedLT` | `boolean` | `true` | When true, a green marker is drawn at the projected lead time position (days from issue creation to current Estimated Date field value). Defaults to `true` because `parseStoredConfig` treats any value other than `'false'` as true. |
| `refreshInterval` | `number` | `0` | Auto-refresh interval in minutes. `0` disables auto-refresh. Available values: 0, 15, 30, 60, 120. |
| `debugMode` | `boolean` | `false` | When true, renders a raw status transition history panel below the chart for every issue. Useful for diagnosing incorrect segment durations. |
| `description` | `string` | `''` | Markdown text displayed below the chart as a rendered HTML block. Intended for team-specific context or legends. |

### Serialization

`StoredWidgetConfig` stores `boolean` fields as strings (`'true'` / `'false'`) and arrays as JSON strings because `host.storeConfig` only accepts flat primitives. `parseStoredConfig` / `serializeConfig` (in `types.ts`) convert between the two forms.

---

## Data Flow

```
YouTrack REST API
      │
      ▼
resources.ts  (loadIssuesWithActivities)
  ├─ Phase 1: paginated GET /issues  →  Issue[]
  └─ Phase 2: sequential GET /issues/{id}/activitiesPage  →  Map<id, IssueActivityItem[]>
      │
      ▼
activity-parser.ts  (buildChartData)
  ├─ parseStateSegments()   →  { segments: StatusSegment[]; neverReachedStartStatus }
  │    Chronological segments, trimmed to start at the first entry into
  │    statusOrder[0]. Statuses outside statusOrder are kept (not dropped)
  │    and flagged isUnconfigured — rendered gray. If statusOrder is empty,
  │    falls back to the legacy behavior: aggregate duration by status name,
  │    no chronology, no gray segments. The timeline's hard end is
  │    `issue.resolved` for resolved issues (Date.now() for open ones) —
  │    any transition at or after that point is dropped entirely, so a
  │    final status (Done/Declined/Closed/...) never renders and totalDays
  │    reflects real lead time to completion, not open-ended growth. This
  │    is driven by the `resolved` field, not by matching status names.
  │    Falls back to synthesizing a single segment from the issue's current
  │    State field (extractCurrentState) when there's no state-change
  │    activity at all (e.g. bulk-imported/seed issues).
  ├─ findLeadTimeStartAt()  →  number (Unix ms) — same start-status match
  │    criterion as parseStateSegments (id OR name — see matchesStatus),
  │    so the segment timeline and the Estimated Date / Projected LT anchor
  │    always agree on "day 0".
  ├─ parseEstimateDateChanges()  →  EstimateDateChange[]  (per-day deduplication)
  └─ buildIssueChartData()  →  IssueChartData  (ready for rendering)
      │
      ▼
app.tsx  (state: chartData IssueChartData[])
  │  sorts by earliest estimate change date (ascending)
  ▼
gantt-chart.tsx  (D3 SVG render)
  ├─ stacked horizontal bars (StatusSegment[])
  ├─ estimate date ticks (EstimateDateChange[])
  ├─ LT threshold markers (ltSettings)
  ├─ projected LT marker (projectedLeadTimeDays)
  └─ y-axis clickable issue ID links
```

### Pagination

Issues are loaded in packs of `ISSUES_PACK_SIZE = 50`. The loop continues while a pack is full-sized. Activities are loaded one issue at a time with a `ACTIVITY_BATCH_DELAY_MS = 100 ms` delay between requests to avoid rate limiting.

### State Change Detection (activity-parser.ts)

Because the YouTrack API returns `field` as a `FilterField` (not a typed `CustomField`), state changes are identified by two parallel strategies:
1. **`$type` check** — any `added`/`removed` value whose `$type` contains `"state"` (case-insensitive).
2. **Field name check** — field names `state`, `status`, `состояние`, `статус`, `estado`, `zustand`, `état`.

### Estimate Date Detection

Activities are filtered by field name containing `"estimated"`, `"due date"`, or `"deadline"`. The date value is extracted in priority order:
1. `val.value` as Unix ms number or string
2. `val.id` as Unix ms number or ISO date string (`YYYY-MM-DD`)
3. `val.presentation` string parsed by `Date.parse()`

### Lead Time Start Anchor (`findLeadTimeStartAt`)

The "day 0" reference for both the Estimated Date ticks and the Projected LT
marker is **not** issue creation time — it's the timestamp the issue first
entered the configured start status (`statusOrder[0]`), matched by id OR by
name (not id-exclusive — the same status can have a different bundle id per
project on a multi-project dashboard). Falls back to issue creation if the
issue never reached the start status, or if `statusOrder` is empty.

### Projected Lead Time Calculation

1. Try `issue.fields` for the current `Estimated Date` field value (most reliable).
2. Fall back to last `estimateDateChanges[last].toDate` or `.fromDate`.
3. `projectedLeadTimeDays = (estimatedDateMs - leadTimeStartAt) / MS_PER_DAY`.

---

## Visual Elements — gantt-chart.tsx

### Layout Constants

```typescript
MARGIN = { top: 20, right: 20, bottom: 40, left: 110 }
ROW_HEIGHT = 28   // px per issue row
BAR_HEIGHT = 20   // ROW_HEIGHT - 2 * ROW_PADDING
TICK_WIDTH = 2    // px stroke width for all tick marks
MIN_CHART_WIDTH = 400
```

### Status Segments (stacked horizontal bars)

- Segments are drawn **in chronological order** (the order `parseStateSegments` returns them in, starting at the first entry into `statusOrder[0]`), left to right — not grouped/aggregated by status name. Each `StatusSegment` with `durationDays > 0` is drawn as a `<rect>`.
- Revisiting the same configured status later (e.g. after a detour through unconfigured statuses) produces a separate segment of the same color, not a merged one — the tooltip shows that visit's own duration, not a running total.
- Color resolution order: `seg.isUnconfigured ? UNCONFIGURED_COLOR (#9E9E9E)` → else `statusColorMap[seg.statusId]` → `statusColorMap[seg.statusName.toLowerCase()]` → `seg.color` → `STATUS_COLORS[segIdx % 10]` (fallback palette).
- Fallback palette (10 colours): `#4CAF50`, `#2196F3`, `#FF9800`, `#9C27B0`, `#F44336`, `#00BCD4`, `#8BC34A`, `#FF5722`, `#607D8B`, `#E91E63`.
- A native SVG `<title>` tooltip shows `"StatusName: N.N days"` on hover, or `"StatusName (not in configured status list): N.N days"` for gray/unconfigured segments.
- If `statusOrder` is empty, segments fall back to the legacy behavior: one aggregated segment per status name found in history (no chronology, no gray).

### X Axis

- Linear scale from `0` to `maxDays * 1.05` where `maxDays = max(totalDays, projectedLeadTimeDays)`.
- Tick labels formatted as `Nd` (e.g., `"30d"`).
- Max 10 ticks, spaced at least 60 px apart.
- Dashed vertical grid lines at each tick.

### Y Axis (Issue IDs)

- Rendered as `<foreignObject>` containing `<a href>` elements.
- Links open `baseUrl/issue/PROJ-N` in a new tab.
- Labels are right-aligned, 11 px, truncated with ellipsis if longer than 110 px.

### Estimate Date Ticks (`showEstimateDate = true`)

- Vertical dark line (`var(--ring-text-color)`, opacity 0.8, 2 px stroke) at the x-position corresponding to `daysSinceCreation` when the estimate was changed.
- Label: for all ticks except the last one, the sequential number (1, 2, …); for the last tick, the **current estimate date** in `DD/MM/YY` format.
- Invisible 12 px wide hit target triggers a tooltip showing: change number, change timestamp, previous estimate, new estimate, author name.

### Lead Time Threshold Markers (`ltEnabled = true`)

- LT50% marker: **orange** `#FFA500`, label `"LT50%"`.
- LT80% marker: **red** `#FF0000`, label `"LT80%"`.
- Both drawn as vertical lines the same height as the bar, with a text label above.
- Type lookup: `ltSettings[issueType] ?? ltSettings[''] ?? ltSettings[first key]`.
- Tooltip shows the threshold label, issue type name, and days (with a weeks conversion for values > 28 days).

### Projected Lead Time Marker (`showProjectedLT = true`)

- **Green** `#22C55E`, stroke-width 2.5, opacity 0.95.
- Label: `"LT-Nw; DD/MM/YY"` (weeks if > 28 days) or `"LT-Nd; DD/MM/YY"` (days).
- Label is right-shifted if it fits within chart width, otherwise left-shifted.
- Tooltip shows days (1 decimal) and estimated date.

### Legend

Rendered above the SVG, one coloured dot + label per `statusOrder` item, plus a fixed gray **"Other"** entry for unconfigured statuses (always shown alongside the rest of the legend, regardless of whether any issue in the current data actually has an unconfigured segment). Uses the same color resolution as segment bars.

### Row Hover

Each row has a transparent full-width background rect that turns `var(--ring-hover-background-color)` on mouseover.

---

## Configuration UI — configuration.tsx

Rendered when no config exists (first install) or when the user clicks the configure button. Uses JetBrains Ring UI components.

Sections in order:
1. **Projects** — multi-select with filter and tag pills. Selecting projects triggers loading of available states and issue types.
2. **Query Filter** — `QueryAssist` component with live autocomplete via `POST /search/assist`.
3. **Status Order** — checkbox list of available statuses (from selected projects), plus an ordered list with ↑/↓ reorder arrows. Only visible when at least one project is selected.
4. **Lead Time Settings** — checkbox to enable + per-type LT50/LT80 number inputs. Requires an enum custom field whose technical name OR project-level display name (`localizedName`) is `"Type"` — a project can rename an existing field's label (e.g. a field technically named `"Client type"` displayed as `"Type"`) without changing its underlying name, and both are matched.
5. **Show Estimate Date history** — checkbox.
6. **Show Projected Lead Time** — checkbox.
7. **Debug mode** — checkbox (Russian label in UI: "Отладка").
8. **Auto-refresh** — dropdown: No auto-refresh / 15 min / 30 min / 1 hour / 2 hours.
9. **Description (Markdown)** — resizable textarea.
10. Version / build time footer (reads `__APP_VERSION__` and `__BUILD_TIME__` build-time constants).

---

## Known Limitations and Quirks

1. **Activity history limit** — the API call requests `$top=1000` activities per issue. Issues with extremely long histories may be silently truncated.

2. **`field` is `FilterField`, not `CustomField`** — the YouTrack `activitiesPage` API does not return a typed `customField` on activity items. State detection falls back to `$type` and field name heuristics, which means unusual field name localizations not in the hardcoded list will be missed.

3. **Estimate date x-position anchor** — estimate ticks are positioned at `daysSinceStart = (changedAt - leadTimeStartAt) / MS_PER_DAY`, where `leadTimeStartAt` is precomputed in `buildIssueChartData` (see `findLeadTimeStartAt`). `gantt-chart.tsx` still has a defensive fallback (`Date.now() - totalDays * MS_PER_DAY`) for the theoretical case where `leadTimeStartAt` is missing, but `buildIssueChartData` always sets it, so that fallback shouldn't normally trigger.

4. **`projectedLT` defaults to `true`** — `parseStoredConfig` evaluates `showProjectedLT !== 'false'`, so any config written before this field existed will display the projected LT marker. This is intentional but may be surprising.

5. **No timezone handling** — all date arithmetic uses UTC milliseconds. `toLocaleDateString()` uses the browser's locale. Users in non-UTC timezones may see the displayed date shifted by one day for near-midnight events.

6. **Statuses never visited produce no segment at all** — since segments are now chronological (one per actual visit), a configured status the issue never entered simply has no corresponding segment (unlike the old aggregate-by-name model, which used to emit an explicit zero-duration placeholder — that placeholder was already invisible in the render, since `gantt-chart.tsx` skips `durationDays <= 0`, so this is a data-shape simplification with no visible effect).

6b. **`neverReachedStartStatus`** — if an issue never entered `statusOrder[0]`, `parseStateSegments` returns the full chronological history from issue creation instead of an empty/trimmed list, and flags `neverReachedStartStatus: true` on `IssueChartData`. There's currently no dedicated visual marker for this (unlike the gray "unconfigured" segments) — it's tracked in the data for potential future use.

7. **Issue type fallback** — LT threshold lookup falls back to `ltSettings['']` (empty-string key), then to the first key in `ltSettings`. Issues without a `Type` field get the fallback threshold if any is defined.

8. **Debug console noise** — `resources.ts` line 222 contains an unconditional `console.log('[DEBUG] activitiesPage raw response: ...')` and `gantt-chart.tsx` contains a `console.log('[PLT] ...')` both of which fire in production. These should be guarded by `debugMode` before shipping.

9. **`host.storeConfig` field schema mismatch** — `widget-settings.json` does not declare `showProjectedLT`, `debugMode`, or `description`. This has no runtime impact (the host ignores undeclared fields) but the schema should be kept in sync.

10. **A brief final-status sliver can still appear if `resolved` lags the actual status change** — segments are capped at `issue.resolved`, not at "whenever the issue entered a resolved-type status." If those two moments aren't simultaneous (e.g. workflow automation sets the state before the `resolved` timestamp is written), the gap between them still renders as a short segment. In practice this is usually near-zero and gets filtered by the `durationDays <= 0` render guard, but it's not a guaranteed zero.
