# Progress Tracking Widget — Developer Documentation

## Overview

**Progress Tracking** is an embeddable YouTrack dashboard widget derived from **Issues Progress** (`src/widgets/issues-progress/`). It renders the same Gantt-style horizontal bar chart of time-in-status, but instead of a single chart for the whole filtered issue set, it **groups issues by the value of a configured enum (reference) custom field** and renders **one independent Gantt chart per group**. Manual Lead Time thresholds (LT50/LT80) are replaced by **automatically computed lead-time percentiles**, calculated separately for each group from that group's resolved issues, and drawn as background zones behind every chart.

Primary use case: compare the actual lead-time distribution across categories of work (e.g. Bug vs Feature vs Task) without hand-tuning per-type norms — the widget derives where the 50th and 80th percentiles actually fall for each group and shades the background accordingly.

See `docs/PROGRESS_TRACKING_SPEC.md` for the full specification this widget was built against.

---

## File Architecture

| File | Responsibility |
|------|---------------|
| `index.tsx` | Widget entry point — mounts the React root |
| `index.html` | Widget HTML shell |
| `app.tsx` | Root React component — lifecycle, data fetching/orchestration, routing between Config / Chart / Debug views |
| `configuration.tsx` | Settings form component — all config fields, project/state/groupable-field loading |
| `grouped-gantt-chart.tsx` | Renders the shared legend plus one `GanttChart` per group, in the order the `groups` Map iterates (already alphabetical) |
| `gantt-chart.tsx` | Pure chart component for a SINGLE group — D3 SVG rendering, all visual elements |
| `activity-parser.ts` | Data transformation layer — raw activity items → chart-ready segments, plus grouping (`groupChartData`) |
| `percentiles.ts` | Percentile math (`computePercentile`, `computeGroupPercentiles`) and the per-group percentile-fetch orchestrator (`fetchGroupPercentiles`) |
| `resources.ts` | YouTrack API layer — all `host.fetchYouTrack()` calls, including groupable-enum-field discovery |
| `types.ts` | TypeScript type definitions + config serialization helpers |
| `gantt-chart.css` | Chart-specific styles (legend, percentile zones, group section headers, tooltip, scroll wrapper) |
| `app.css` | App-level styles (loading, error, empty, debug panel) |
| `widget-settings.json` | JSON Schema for the stored config (used by YouTrack host) |
| `widget-icon.svg` | Widget icon shown in the dashboard palette |

---

## WidgetConfig — All Fields

Defined in `types.ts` as `WidgetConfig` (in-memory) and `StoredWidgetConfig` (persisted via `host.storeConfig`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | `string \| undefined` | `undefined` | Optional custom widget title shown in the dashboard header. Falls back to `"Progress Tracking"`. The rendered title also gets a live issue count suffix, e.g. `"Progress Tracking (42)"`. |
| `projects` | `string[]` | `[]` | Array of YouTrack project internal IDs. Used only to load available statuses and groupable enum fields for the configuration form — NOT used to filter the query directly. |
| `primarySearch` | `string` | `''` | YouTrack search query. Functionally required — the Save button in `configuration.tsx` is disabled while `primarySearch.trim()` is empty, and `app.tsx` treats an unset `primarySearch` as "no config yet" and forces config mode. Determines chart composition (combined with `additionalSearch`) AND is the base query for percentile computation (combined with `groupByField: value`). |
| `additionalSearch` | `string` | `''` | Optional second filter. Narrows chart composition only (`(primarySearch) and (additionalSearch)`) — does NOT narrow the percentile sample, so background zones keep reflecting the "normal" distribution even when the visible chart is filtered down. |
| `groupByField` | `string` | `''` (auto-picked in the UI) | Technical name of the enum custom field issues are grouped by. `configuration.tsx` auto-selects a field named/localized `"Type"` if present, else the first available groupable field — but only for a brand-new widget with no previously saved `groupByField`. |
| `statusOrder` | `StatusOrderItem[]` | `[]` | Same as Issues Progress — defines the start status (`statusOrder[0]`, used as the lead-time "day 0" anchor) and the stacking order/color of segments. Shared across all group charts. |
| `showProjectedLT` | `boolean` | `true` (per `parseStoredConfig`'s `!== 'false'` check) / `false` in a brand-new `configuration.tsx` form | Shows a green marker at the current Estimated Date field's projected lead-time position. Same algorithm as Issues Progress. |
| `gridStep` | `GridStep` (`1 \| 7 \| 14 \| 28`) | `1` | Days between X-axis grid ticks/gridlines — **shared across every group chart** so charts stay visually comparable even though each has its own X domain. |
| `sortBy` | `'startDate' \| 'issueNumber' \| 'estimatedDate'` | `'startDate'` | Row order **within each group's chart** (not global). |
| `refreshInterval` | `number` | `0` | Minutes between auto-refreshes; `0` disables auto-refresh. UI options: 0 (off), 15, 30, 60, 120. |
| `debugMode` | `boolean` | `false` | Shows a raw status-transition-history panel below the charts, one block per issue across the full (ungrouped) `chartData` list. |
| `description` | `string` | `''` | Markdown text rendered (via `marked` + `DOMPurify`) below the charts. |

Removed relative to Issues Progress: `search` (split into `primarySearch` + `additionalSearch`), `ltEnabled`, `ltSettings`, `showEstimateDate` (and its tick-mark history rendering).

### Serialization

`StoredWidgetConfig` stores boolean fields as strings (`'true'` / `'false'`) and arrays/objects as JSON strings, because `host.storeConfig` only accepts flat primitives. `gridStep` and `refreshInterval` are stored as numbers directly (matching `issue-state-history`'s `GridStep` pattern rather than issues-progress's all-string convention). `parseStoredConfig` / `serializeConfig` (in `types.ts`) convert between the two forms — `parseGridStep`/`parseSortBy` clamp any stored value outside the known enum back to the default (`1` / `'startDate'`) rather than throwing.

---

## Data Flow

```
YouTrack REST API
      │
      ▼
resources.ts  (loadIssuesWithActivities)
  ├─ Phase 1: paginated GET /issues  →  Issue[]            (query = combinedQuery)
  └─ Phase 2: sequential GET /issues/{id}/activitiesPage    →  Map<id, IssueActivityItem[]>
      │
      ▼
activity-parser.ts  (buildChartData)
  ├─ parseStateSegments() / findLeadTimeStartAt() / parseEstimateDateChanges()
  │    — identical algorithms to Issues Progress, unchanged.
  └─ buildIssueChartData()  →  IssueChartData  (now also carries `groupValue`,
       read via extractGroupFieldValue(issue, groupByField))
      │
      ▼
activity-parser.ts  (groupChartData)
  ├─ buckets the flat IssueChartData[] by groupValue (unset/absent → key '')
  ├─ sorts EACH bucket independently by sortBy (sortChartDataInPlace)
  └─ returns a Map<string, IssueChartData[]> with keys in ascending
     localeCompare order (alphabetical, '' sorts wherever localeCompare puts
     an empty string — see Known Limitations)
      │
      ▼
percentiles.ts  (fetchGroupPercentiles)
  ├─ additionalSearch empty  → reuse already-loaded resolved issues, no extra REST calls
  └─ additionalSearch non-empty → one GET /issues (+activities) request PER group,
     in parallel via Promise.all, using buildGroupQuery()
  → computeGroupPercentiles()  →  Map<groupValue, {p50, p80} | null>
      │
      ▼
app.tsx  (state: chartData, groups, percentilesByGroup)
      │
      ▼
grouped-gantt-chart.tsx
  ├─ renders ONE shared legend (statusOrder + "Other")
  └─ for each (groupKey, items) in groups (alphabetical):
       renders <GanttChart data={items} percentiles={percentilesByGroup.get(groupKey)} .../>
      │
      ▼
gantt-chart.tsx  (D3 SVG render, one instance per group)
  ├─ percentile background zones (green/yellow/red, from this group's {p50,p80})
  ├─ stacked horizontal bars (StatusSegment[])
  ├─ gridStep-aligned grid lines / X axis
  ├─ projected LT marker (projectedLeadTimeDays)
  └─ y-axis clickable issue ID links
```

### Pagination and throttling

Unchanged from Issues Progress: issues are loaded in packs of `ISSUES_PACK_SIZE = 50`; activities are loaded one issue at a time with an `ACTIVITY_BATCH_DELAY_MS = 100 ms` delay between requests. When `additionalSearch` is non-empty, this entire two-phase load is repeated once per distinct group value inside `fetchGroupPercentiles` (see Known Limitations).

### Combined query construction

`app.tsx`'s `buildCombinedQuery(primarySearch, additionalSearch)` returns `(${primarySearch}) and (${additionalSearch})` when `additionalSearch` is non-blank, else just `primarySearch` unchanged (no redundant wrapping parens when there's nothing to combine).

---

## Percentile Calculation (`percentiles.ts`)

### Sample definition

Per spec, the percentile sample for group `G` is: all issues matching `primarySearch AND groupByField = G AND resolved != null` — **not** narrowed by `additionalSearch`, and computed independently from what's actually drawn on group `G`'s chart (which DOES include open issues and IS narrowed by `additionalSearch`).

### Lead time per issue (`leadTimeDaysForResolvedIssue`)

```
leadTimeDays = (issue.resolved - leadTimeStartAt) / MS_PER_DAY
```
where `leadTimeStartAt = findLeadTimeStartAt(activities, statusOrder, issue.created)` — the exact same "day 0" anchor used for the chart's own segments and the Projected LT marker, so the percentile sample and the chart agree on what "lead time" means. Returns `null` (excluded from the sample) when the issue isn't resolved, or defensively when the computed value is `NaN` or negative.

This is computed directly from `Issue` + `IssueActivityItem[]` + `statusOrder`, independently of any already-built `IssueChartData` — deliberately, because the percentile sample can include issues that aren't part of the rendered dataset at all (when `additionalSearch` narrows the chart but not the percentile base).

### Percentile formula (`computePercentile`)

Linear interpolation — equivalent to Excel `PERCENTILE.INC` / numpy `'linear'` (method R-7). For an ascending-sorted array `days[0..n-1]` and percentile `p` (0–100):

```
index = (p / 100) * (n - 1)
lower = floor(index), upper = ceil(index)
value = days[lower] + (days[upper] - days[lower]) * (index - lower)
```

`computeGroupPercentiles` handles the edge cases before calling this: `n === 0` → the group maps to `null` (no background zone — `gantt-chart.tsx` skips zone rendering entirely when `percentiles === null`, but the chart itself still renders if the group has any issues at all, resolved or not); `n === 1` → both `p50` and `p80` equal that single value.

### Data source: reuse vs. extra fetch

- **`additionalSearch` empty**: the resolved-issue population needed for percentiles is *exactly* the resolved subset of the data already fetched for `primarySearch` (since `additionalSearch` isn't in the equation and doesn't narrow anything). `fetchGroupPercentiles` reuses `alreadyLoaded.issues`/`alreadyLoaded.activitiesMap` (the same load `app.tsx` already did for the chart) via `collectLeadTimesByGroup` — **zero extra REST calls**.
- **`additionalSearch` non-empty**: the percentile population is now wider than what's rendered, so a separate `loadIssuesWithActivities` call per distinct group value is issued in parallel (`Promise.all`), using `buildGroupQuery(primarySearch, groupByField, groupValue)` → `(${primarySearch}) and (${groupByField}: {${groupValue}})`. Curly braces are YouTrack query syntax for values containing spaces. Results are re-filtered client-side by `extractGroupFieldValue` as a defensive check against imperfect query narrowing (skipped for the `''`/no-value group — see Known Limitations).

---

## Grouping (`activity-parser.ts` — `groupChartData`)

- Groups the flat `IssueChartData[]` (already filtered at the REST level by `primarySearch AND additionalSearch`) by `item.groupValue ?? ''`.
- Issues where the field is absent from the project, or present but unset on that issue, land in the group keyed by the **empty string `''`** — not dropped. `grouped-gantt-chart.tsx` displays this group's title as `(без значения)` ("no value").
- Group iteration order is **alphabetical**: `Array.from(byGroup.keys()).sort((a, b) => a.localeCompare(b))`. Where `''` sorts relative to real values is whatever the JS engine's `localeCompare('', x)` returns (typically first, since empty string precedes any non-empty string), not an explicitly pinned position.
- Within each group, rows are sorted independently by `sortBy` via `sortChartDataInPlace` — unlike Issues Progress, there is no global sort across the whole dataset.

---

## Visual Elements

### Shared across all group charts (`grouped-gantt-chart.tsx`)

- **One legend**, rendered once above all group charts: a colored dot + label per `statusOrder` item, plus a fixed gray **"Other"** entry for unconfigured statuses (always shown, regardless of whether any currently-loaded issue actually has an unconfigured segment).
- **Group section title**: `"{groupFieldLabel}: {value} (N)"` (or just `"{value} (N)"` if no `groupFieldLabel`), where `N` is the group's issue count and `value` is `(без значения)` for the `''` group.
- Groups render **vertically stacked**, one `GanttChart` instance per group, inside a single scrollable container (`ip-groups-scroll`).
- If `groups` is empty, renders `"No issues found."` instead of any charts.

### Per-group chart (`gantt-chart.tsx`) — layout constants

```typescript
MARGIN = { top: 20, right: 20, bottom: 40, left: 110 }
ROW_HEIGHT = 28
BAR_HEIGHT = 20   // ROW_HEIGHT - 2 * ROW_PADDING
MIN_CHART_WIDTH = 400
```

### Percentile background zones

Drawn FIRST (before rows/segments, so bars sit on top), only when `percentiles !== null`:
- `0 → p50`: green, `#4CAF50` at 12% fill-opacity.
- `p50 → p80`: yellow, `#FFC107` at 15% fill-opacity.
- `p80 → maxDomain (chart right edge)`: red, `#F44336` at 12% fill-opacity.

Coordinates use this chart's OWN `xScale` (each group has its own X domain, since `maxDays = max(totalDays-in-this-group, projectedLT-in-this-group, this-group's p80)`), but the same `gridStep` value is passed to every instance so the tick/gridline spacing (in days) looks the same across groups even though the domains differ. Zones with non-positive width (e.g. `p50 === 0`) are skipped.

### Status segments (stacked horizontal bars)

Same rendering model as Issues Progress: drawn in chronological order (not aggregated by name), one `<rect>` per `StatusSegment` with `durationDays > 0`. Color resolution: `isUnconfigured ? UNCONFIGURED_COLOR (#9E9E9E)` → `statusColorMap[statusId]` → `statusColorMap[statusName.toLowerCase()]` → `seg.color` → fallback palette `STATUS_COLORS[segIdx % 10]`. Native SVG `<title>` tooltip on hover.

### X axis / grid

- Linear scale `[0, maxDays * 1.05]` where `maxDays = max(totalDays, projectedLeadTimeDays, percentiles?.p80 ?? 0)` for THIS group only.
- Tick values are every multiple of `gridStep` from `0` up to the domain max (`for (let t = 0; t <= maxDomain; t += gridStep)`) — not D3's automatic tick placement, so the spacing is exactly `gridStep` days everywhere, independent of chart width.
- Dashed vertical grid lines at each tick; labels formatted `"Nd"`.

### Y axis (issue IDs)

Rendered as `<foreignObject>` containing `<a href>`, right-aligned, 11 px, truncated with ellipsis. Links open `baseUrl/issue/PROJ-N` in a new tab. Hovering the label shows a tooltip with the issue summary and total lead time in days.

### Projected Lead Time marker (`showProjectedLT = true`)

Identical to Issues Progress: green `#22C55E`, stroke-width 2.5, label `"LT-Nw; DD/MM/YY"` (weeks if > 28 days) or `"LT-Nd; DD/MM/YY"`, right-shifted unless it would overflow the chart, in which case left-shifted. Tooltip shows days (1 decimal) and the estimated date.

### Removed relative to Issues Progress

- LT50/LT80 threshold markers and `ltSettings` per-issue-type configuration — replaced entirely by the automatic per-group percentile zones above.
- Estimate Date change history tick marks (`showEstimateDate`) — only the CURRENT estimate (via `showProjectedLT`) is still shown.

---

## Configuration UI — `configuration.tsx`

Rendered when no config exists (first install) or when the user clicks the configure button. Uses JetBrains Ring UI components; labels are in Russian (project convention), matching the donor widget's UI language even though this documentation is in English.

Sections in order:
1. **Title** — optional text input.
2. **Projects** — multi-select with filter and tag pills. Selecting projects triggers loading of available states AND groupable enum fields (`loadProjectCustomFields`).
3. **Основной фильтр** (Primary filter) — `QueryAssist` with live autocomplete via `POST /search/assist`.
4. **Дополнительный фильтр** (Additional filter, optional) — second `QueryAssist`, shares the same `queryAssistHandler`.
5. **Группировать по** (Group by) — `Select`, only shown once ≥1 project is selected. Populated from `availableGroupableFields`. On first load for a brand-new widget (no `groupByField` in the config the form was opened with — tracked via `hadInitialGroupByField` ref), auto-picks a field named/localized `"Type"` if present, else the first available field (`applyDefaultGroupByField`); this auto-pick never overrides a value the user already has saved or has changed in this session. Shows a warning message instead of the select if the selected projects have no groupable enum fields at all.
6. **Status Order** — checkbox list of available statuses plus an ordered list with ↑/↓ reorder arrows; only visible when ≥1 project selected. Changing selected projects prunes any `statusOrder` entries no longer present in the new project set.
7. **Show Projected Lead Time** — checkbox.
8. **Debug (Отладка)** — checkbox.
9. **Шаг сетки** (Grid step) — `Select` with options 1 день / Неделя (7 дней) / 2 недели (14 дней) / 4 недели (28 дней).
10. **Сортировка** (Sort) — `Select`: Дата старта / По номеру / Estimated Date.
11. **Auto-refresh** — `Select`: No auto-refresh / 15 min / 30 min / 1 hour / 2 hours.
12. **Description (Markdown)** — resizable textarea.
13. Version / build time footer (`__APP_VERSION__` / `__BUILD_TIME__`).

The **Save** button is disabled while `primarySearch.trim()` is empty — this is the only field enforced as required in the UI (there is no `"required"` entry in `widget-settings.json`, matching the donor widget's schema, which also leaves `search` unmarked despite being functionally mandatory).

---

## Known Limitations and Quirks

1. **`buildGroupQuery` cannot express "field is not set" for the `''` group** — when `additionalSearch` is non-empty (triggering the per-group REST-fetch branch), the percentile query for the "no value" group (`groupValue === ''`) falls back to the unfiltered `primarySearch` (no reliable cross-localization YouTrack syntax for "field unset"). This means the percentiles shown for the "(без значения)" group's background zone, in that specific configuration, are actually computed over the ENTIRE resolved `primarySearch` population — not strictly issues with the field unset. Documented as a deliberate simplification in `buildGroupQuery`'s doc comment and `percentiles.ts`'s `fetchGroupPercentiles`, not a bug to fix silently.

2. **N+1 REST round-trips when `additionalSearch` is set** — `fetchGroupPercentiles` issues one full `loadIssuesWithActivities` call (paginated issues + per-issue activities) PER distinct group value, in parallel. On a dashboard with many group values and/or large per-group issue counts, this multiplies both request volume and load time considerably compared to the `additionalSearch`-empty path, which does zero extra calls. There's no caching or dedup between this fetch and the main chart fetch beyond the empty-`additionalSearch` reuse path.

3. **Per-group X domains make cross-group bar-length comparison visually approximate** — only the grid STEP (in days) is guaranteed identical across group charts; the domain max (and therefore how many grid lines a chart shows, and where its right edge falls) varies per group based on that group's own `totalDays`/`projectedLeadTimeDays`/`p80`. Two bars of equal pixel length in different group charts are not necessarily equal in days — only the tick spacing is comparable at a glance, not raw bar width.

4. **`groupByField` empty or unresolved excludes nothing but also groups nothing meaningfully** — if `groupByField` is `''` (e.g. a saved config from before any groupable field existed, or a project with zero enum fields), `extractGroupFieldValue` returns `undefined` for every issue and `groupChartData` puts every issue into the single `''` group. The widget still renders (one chart titled "(без значения)"), but the grouping feature is effectively inert until a valid field is chosen.

5. **`localeCompare('', x)` ordering of the "no value" group is not explicitly pinned** — `groupChartData` sorts keys via plain `localeCompare`, so where the `''` key lands relative to real values depends on the JS engine's collation behavior for empty string (in practice, first — before any non-empty string — in V8), not a hardcoded position. This has no functional impact today (only display order), but should not be relied upon as a documented contract if it ever needs to change.

6. **Percentile sample and per-group chart data are computed via separate code paths that must stay in lock-step** — `leadTimeDaysForResolvedIssue` in `percentiles.ts` recomputes lead time from raw `Issue`/`IssueActivityItem[]` rather than reading `totalDays`/`leadTimeStartAt` off an already-built `IssueChartData`. Both paths call `findLeadTimeStartAt` with the same `statusOrder`, so they agree today, but any future change to lead-time calculation must be applied in both `activity-parser.ts` (`buildIssueChartData`) and `percentiles.ts` (`leadTimeDaysForResolvedIssue`) or the chart and its background zones will silently drift out of sync.

7. **Activity history limit (inherited from Issues Progress)** — `activitiesPage` is requested with `$top=1000`; issues with longer histories are silently truncated (a `console.warn` fires, but nothing in the UI signals it).

8. **State/estimate-date detection language heuristics (inherited)** — same `$type`/field-name matching as Issues Progress (hardcoded localizations: state/status/состояние/статус/estado/zustand/état; estimate fields matched by substring `estimated`/`due date`/`deadline`). Unlisted localizations are silently missed.

9. **`debugMode` renders history for the full flat `chartData`, not per-group** — the debug panel in `app.tsx` iterates the flat (ungrouped) list, so it doesn't reflect the group boundaries shown above it; this is intentional (debug is a diagnostic dump of everything loaded, not a per-chart view) but can be surprising if the count of debug entries doesn't obviously match any single group's issue count shown above.

10. **No timezone handling (inherited)** — all date arithmetic is in UTC milliseconds; `toLocaleDateString()` uses the browser locale, so near-midnight events can appear shifted by a day for non-UTC users.

11. **`showProjectedLT` default mismatch between a brand-new form and a re-parsed stored config** — `configuration.tsx`'s initial React state defaults to `false` (`config?.showProjectedLT ?? false`) for a widget with no config yet, but `parseStoredConfig` defaults an *existing but pre-this-field* stored config to `true` (`stored.showProjectedLT !== 'false'`). This mirrors an existing Issues Progress quirk and is intentional, but the two "defaults" disagree depending on which code path you're looking at.
