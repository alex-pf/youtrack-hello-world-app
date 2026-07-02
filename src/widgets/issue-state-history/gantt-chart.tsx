import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { IssueStateHistoryData, DateSegment, StatusOrderItem, GridStep, ChartIndicator } from './types';
import './gantt-chart.css';

interface GanttChartProps {
  data: IssueStateHistoryData[];
  statusOrder: StatusOrderItem[];
  baseUrl: string;
  gridStep: GridStep;
  // Set of ChartIndicator.semanticType values currently toggled ON in the
  // app.tsx indicator panel. Indicators whose semanticType is set but not
  // present in this set are filtered out before rendering. Indicators with
  // no semanticType are always shown (nothing to toggle them by). Undefined
  // means "no filtering" (show everything) — useful for callers that don't
  // wire up the toggle panel.
  visibleIndicatorTypes?: Set<string>;
}

// ─── Layout constants ─────────────────────────────────────────────────────────
// Width of the frozen (non-scrolling) labels pane on the left. Previously this
// was MARGIN.left inside a single SVG; now it sizes its own standalone pane.
const LABELS_WIDTH = 110;
// Small internal left margin inside the chart SVG itself (room for the first
// axis tick label / grid line not to butt up against the pane edge).
const MARGIN = { top: 20, right: 20, bottom: 40, left: 8 };
const ROW_HEIGHT = 28;
const ROW_PADDING = 4;
const BAR_HEIGHT = ROW_HEIGHT - ROW_PADDING * 2;
const MIN_CHART_WIDTH = 400;
// Minimum horizontal pixels allotted per GRID UNIT (one tick/gridline
// interval, matching the configured gridStep) in the scrollable chart pane.
// The chart's width is `unitsInDomain * MIN_PX_PER_UNIT[gridStep]` and never
// compresses narrower than that — the pane scrolls horizontally instead
// (see chartInnerWidth below). Values chosen so date tick labels stay
// legible without overlapping, since each grid unit gets exactly one tick:
//   day:   24px — a short "%d %b" label (e.g. "01 Jan") fits comfortably in
//          ~24px when ticks are dense; this matches the original 12px/day
//          heuristic doubled, since ticks now render on every day instead
//          of a "nice" subset.
//   week:  40px — one tick per ISO week; slightly more room than a day
//          because week labels also show "%d %b" but readers need to
//          visually distinguish adjacent week boundaries.
//   month: 60px — one tick per month; "%b %y" (e.g. "Jan 26") is wider than
//          the day/week formats, so it gets the most room per unit.
const MIN_PX_PER_UNIT: Record<GridStep, number> = {
  day: 24,
  week: 40,
  month: 60,
};

// ─── Color palette for statuses (fallback if no color from API) ───────────────
const STATUS_COLORS = [
  '#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336',
  '#00BCD4', '#8BC34A', '#FF5722', '#607D8B', '#E91E63',
];

// Fixed gray used ONLY for segments whose status is not present in the
// configured statusOrder (isUnconfigured === true). This is a deliberate
// "unknown status" signal and must never be reused as a fallback palette
// color for configured-but-colorless statuses.
const UNCONFIGURED_COLOR = '#9E9E9E';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Indicator defaults ────────────────────────────────────────────────────
// Per-kind fallback colors, used when a ChartIndicator doesn't set its own
// `color`. 'hatch' now defaults to red — blocking periods (Task 4) are the
// only real hatch consumer, and they already pass color: '#F44336'
// explicitly, but the shared default is updated too (rather than kept as
// the old neutral-gray placeholder) since any future hatch producer would
// almost certainly also want a "this is a problem period" red by default.
const INDICATOR_DEFAULT_COLOR: Record<ChartIndicator['kind'], string> = {
  marker: '#607D8B',
  flag: '#FF5722',
  hatch: '#F44336',
};

// SVG <pattern> id for the diagonal hatch fill, defined once in <defs> and
// referenced by every 'hatch' indicator via fill="url(#...)".
const HATCH_PATTERN_ID = 'ish-gantt-hatch-pattern';

// Width (px) of the invisible, wider hover/tooltip hit-area drawn behind
// each point-in-time indicator (marker/flag). The visible glyphs are only
// 1.5-2px wide, which is hard to hover precisely — this pads the actual
// mouse target without changing what's drawn.
const INDICATOR_HIT_WIDTH = 12;

// Rough heuristic for estimating rendered text width of a flag's inline
// label, in px per character, at the label's font-size (10px, see CSS).
// This is deliberately crude (no canvas measureText call) — it just needs
// to be conservative enough to avoid obviously-overlapping labels; exact
// pixel accuracy isn't required per the task spec.
const FLAG_LABEL_PX_PER_CHAR = 6;
// Minimum gap (px) we insist on keeping between a flag's label and whatever
// comes next (next indicator or the row/chart edge), so labels don't butt
// up against neighboring content even when they technically "fit".
const FLAG_LABEL_MIN_GAP = 4;

// ─── XSS-safe tooltip builder ─────────────────────────────────────────────────
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTooltipHtml(title: string, rows: { label: string; value: string }[]): string {
  const rowsHtml = rows
    .map(
      (r) =>
        `<div class="ish-gantt-tooltip__row"><span class="ish-gantt-tooltip__label">${escHtml(r.label)}:</span><span>${escHtml(r.value)}</span></div>`
    )
    .join('');
  return `<div class="ish-gantt-tooltip__header">${escHtml(title)}</div>${rowsHtml}`;
}

export default function GanttChart({ data, statusOrder, baseUrl, gridStep, visibleIndicatorTypes }: GanttChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const labelsSvgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [debouncedWidth, setDebouncedWidth] = useState(containerWidth);

  // ─── Responsive width via ResizeObserver ────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 600;
      setContainerWidth(width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // ─── Debounce containerWidth (150ms) to avoid thrashing D3 on every resize ──
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedWidth(containerWidth);
    }, 150);
    return () => clearTimeout(timer);
  }, [containerWidth]);

  // ─── D3 render ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current || !labelsSvgRef.current || data.length === 0) return;

    const tooltipEl = tooltipRef.current;
    const containerEl = containerRef.current;

    const moveTooltip = (event: MouseEvent) => {
      if (!tooltipEl || !containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      let x = event.clientX - rect.left + 12;
      let y = event.clientY - rect.top - 10;

      const tooltipRect = tooltipEl.getBoundingClientRect();
      if (x + tooltipRect.width > rect.width) {
        x = event.clientX - rect.left - tooltipRect.width - 12;
      }
      if (y + tooltipRect.height > rect.height) {
        y = event.clientY - rect.top - tooltipRect.height - 10;
      }
      tooltipEl.style.left = `${x}px`;
      tooltipEl.style.top = `${y}px`;
    };

    const hideTooltip = () => {
      if (tooltipEl) {
        tooltipEl.style.display = 'none';
      }
    };

    const showSegmentTooltip = (event: MouseEvent, seg: DateSegment) => {
      if (!tooltipEl) return;
      const durationDays = (seg.endDate - seg.startDate) / DAY_MS;
      const title = seg.isUnconfigured ? 'Unknown/unconfigured status' : seg.statusName;
      const rows: { label: string; value: string }[] = [];
      if (seg.isUnconfigured) {
        rows.push({ label: 'Status', value: `${seg.statusName} (not in configured status list)` });
      }
      rows.push({ label: 'Start', value: new Date(seg.startDate).toLocaleDateString() });
      rows.push({ label: 'End', value: new Date(seg.endDate).toLocaleDateString() });
      rows.push({ label: 'Duration', value: `${durationDays.toFixed(1)} days` });
      tooltipEl.innerHTML = buildTooltipHtml(title, rows);
      tooltipEl.style.display = 'block';
      moveTooltip(event);
    };

    // Shared tooltip handler for ALL indicator kinds (marker/flag/hatch) —
    // every ChartIndicator already carries its own tooltipTitle/tooltipRows,
    // so this just wires them into the existing tooltip DOM element rather
    // than each kind reimplementing tooltip logic.
    const showIndicatorTooltip = (event: MouseEvent, indicator: ChartIndicator) => {
      if (!tooltipEl) return;
      tooltipEl.innerHTML = buildTooltipHtml(indicator.tooltipTitle, indicator.tooltipRows);
      tooltipEl.style.display = 'block';
      moveTooltip(event);
    };

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    const labelsSvg = d3.select(labelsSvgRef.current);
    labelsSvg.selectAll('*').remove();

    const chartHeight = data.length * ROW_HEIGHT;
    const totalHeight = chartHeight + MARGIN.top + MARGIN.bottom;

    // ─── X domain (calendar dates) ──────────────────────────────────────────
    const minStart = d3.min(data, (d) => d.overallStart) ?? Date.now();
    const maxEnd = d3.max(data, (d) => d.overallEnd) ?? Date.now();
    // Pad the domain by ~3% of the range on each side (minimum 1 day) so bars
    // at the very edges aren't clipped against the axis.
    const rangeMs = Math.max(maxEnd - minStart, DAY_MS);
    const padMs = Math.max(rangeMs * 0.03, DAY_MS);
    const xDomain: [Date, Date] = [new Date(minStart - padMs), new Date(maxEnd + padMs)];

    // ─── Grid-unit interval matching the configured gridStep ────────────────
    const timeInterval = gridStep === 'week' ? d3.timeWeek : gridStep === 'month' ? d3.timeMonth : d3.timeDay;

    // Number of grid units spanned by the domain (e.g. days, ISO weeks, or
    // months). Used to size the chart width and drives the minimum-width
    // guarantee below, so the chart never compresses narrower than one
    // MIN_PX_PER_UNIT per grid unit.
    const unitsInDomain = Math.max(1, timeInterval.count(xDomain[0], xDomain[1]));

    // ─── Chart pane width: driven by date range, never narrower than the
    // available scroll-pane space (containerWidth minus the frozen labels
    // pane and the chart's own left/right margins). This is what makes the
    // chart overflow (and the horizontal scrollbar appear) when the date
    // range is wide, instead of always being compressed to fit. ───────────
    const availableWidth = Math.max(debouncedWidth - LABELS_WIDTH, MIN_CHART_WIDTH - LABELS_WIDTH);
    const chartInnerWidth = Math.max(unitsInDomain * MIN_PX_PER_UNIT[gridStep], availableWidth - MARGIN.left - MARGIN.right);
    const svgWidth = chartInnerWidth + MARGIN.left + MARGIN.right;

    const xScale = d3.scaleTime().domain(xDomain).range([0, chartInnerWidth]);

    // ─── Y scale (issues) — shared between labels pane and chart pane ──────
    const yScale = d3.scaleBand()
      .domain(data.map((d) => d.issueId))
      .range([0, chartHeight])
      .padding(0);

    // ─── Labels pane (frozen, no horizontal scroll) ─────────────────────────
    labelsSvg
      .attr('width', LABELS_WIDTH)
      .attr('height', totalHeight)
      .attr('aria-label', `Issue labels: ${data.length} issues`);

    const labelsG = labelsSvg
      .append('g')
      .attr('transform', `translate(0,${MARGIN.top})`);

    data.forEach((issueData) => {
      const y = yScale(issueData.issueId) ?? 0;
      const issueUrl = baseUrl ? `${baseUrl}/issue/${issueData.idReadable}` : undefined;

      const fo = labelsG.append('foreignObject')
        .attr('x', 0)
        .attr('y', y + ROW_PADDING)
        .attr('width', LABELS_WIDTH - 4)
        .attr('height', BAR_HEIGHT);

      if (issueUrl) {
        // `as any` is required because D3's TypeScript types do not include the
        // xhtml: namespace prefix needed to render an <a> element inside SVG
        // foreignObject. The xhtml: prefix is the correct W3C way to embed HTML
        // elements in SVG, but @types/d3 only exposes standard SVG element names.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fo.append('xhtml:a' as any)
          .attr('href', issueUrl)
          .attr('target', '_blank')
          .attr('rel', 'noopener noreferrer')
          .attr('title', issueData.summary)
          .style('display', 'block')
          .style('overflow', 'hidden')
          .style('text-overflow', 'ellipsis')
          .style('white-space', 'nowrap')
          .style('font-size', '11px')
          .style('line-height', `${BAR_HEIGHT}px`)
          .style('color', 'var(--ring-link-color)')
          .style('text-decoration', 'none')
          .style('text-align', 'right')
          .style('padding-right', '4px')
          .text(issueData.idReadable);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fo.append('xhtml:div' as any)
          .attr('title', issueData.summary)
          .style('overflow', 'hidden')
          .style('text-overflow', 'ellipsis')
          .style('white-space', 'nowrap')
          .style('font-size', '11px')
          .style('line-height', `${BAR_HEIGHT}px`)
          .style('color', 'var(--ring-text-color)')
          .style('text-align', 'right')
          .style('padding-right', '4px')
          .text(issueData.idReadable);
      }
    });

    // ─── Chart pane (scrollable, no left margin needed) ─────────────────────
    svg
      .attr('width', svgWidth)
      .attr('height', totalHeight)
      .attr('aria-label', `Issue State History chart: ${data.length} issues`);

    // ─── <defs>: diagonal hatch pattern for 'hatch' indicators ───────────────
    // Defined once and referenced by every hatch rect via fill="url(#id)"
    // rather than faking hatching with many thin rects (per task spec).
    const defs = svg.append('defs');
    const hatchPattern = defs.append('pattern')
      .attr('id', HATCH_PATTERN_ID)
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 6)
      .attr('height', 6)
      .attr('patternTransform', 'rotate(45)');
    hatchPattern.append('rect')
      .attr('width', 6)
      .attr('height', 6)
      .attr('fill', INDICATOR_DEFAULT_COLOR.hatch)
      .attr('fill-opacity', 0.15);
    hatchPattern.append('line')
      .attr('x1', 0)
      .attr('y1', 0)
      .attr('x2', 0)
      .attr('y2', 6)
      .attr('stroke', INDICATOR_DEFAULT_COLOR.hatch)
      .attr('stroke-width', 3);

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    // ─── Axis + grid lines ───────────────────────────────────────────────────
    // Ticks/gridlines align exactly to day/week/month boundaries per the
    // configured gridStep, rather than D3's automatic "nice" tick selection —
    // this is what makes the grid step configuration visible on the chart.
    const tickFormat = gridStep === 'month' ? '%b %y' : '%d %b';
    const tickValues = timeInterval.range(xDomain[0], xDomain[1]);
    // Ensure the final boundary is included even if range() stops short of it.
    if (tickValues.length === 0 || tickValues[tickValues.length - 1].getTime() < xDomain[1].getTime()) {
      tickValues.push(xDomain[1]);
    }

    const xAxis = d3.axisBottom<Date>(xScale)
      .tickValues(tickValues)
      .tickFormat((d) => d3.timeFormat(tickFormat)(d as Date));

    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0,${chartHeight})`)
      .call(xAxis);

    g.append('g')
      .attr('class', 'grid-lines')
      .selectAll('line')
      .data(tickValues)
      .enter()
      .append('line')
      .attr('x1', (d) => xScale(d))
      .attr('x2', (d) => xScale(d))
      .attr('y1', 0)
      .attr('y2', chartHeight)
      .attr('stroke', 'var(--ring-line-color)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3');

    // ─── Build status color map ───────────────────────────────────────────────
    // Only used for configured statuses (statusId present in statusOrder).
    // Unconfigured segments always render with UNCONFIGURED_COLOR, never
    // falling back into this palette.
    const statusColorMap = new Map<string, string>();
    statusOrder.forEach((s, i) => {
      const color = s.color ?? STATUS_COLORS[i % STATUS_COLORS.length];
      statusColorMap.set(s.id, color);
      statusColorMap.set(s.name.toLowerCase(), color);
    });

    const colorForSegment = (seg: DateSegment): string => {
      if (seg.isUnconfigured || seg.statusId === null) return UNCONFIGURED_COLOR;
      return (
        (seg.statusId ? statusColorMap.get(seg.statusId) : undefined) ??
        statusColorMap.get(seg.statusName.toLowerCase()) ??
        UNCONFIGURED_COLOR
      );
    };

    // ─── Issue rows ───────────────────────────────────────────────────────────
    const rows = g.selectAll<SVGGElement, IssueStateHistoryData>('.issue-row')
      .data(data)
      .enter()
      .append('g')
      .attr('class', 'issue-row')
      .attr('transform', (d) => `translate(0,${yScale(d.issueId) ?? 0})`);

    // Row background (hover highlight)
    rows.append('rect')
      .attr('class', 'row-bg')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', chartInnerWidth)
      .attr('height', ROW_HEIGHT)
      .attr('fill', 'transparent')
      .on('mouseover', function () {
        d3.select(this).attr('fill', 'var(--ring-hover-background-color)');
      })
      .on('mouseout', function () {
        d3.select(this).attr('fill', 'transparent');
      });

    // ─── Status segments (calendar-date rects) ────────────────────────────────
    rows.each(function (issueData) {
      const rowG = d3.select(this);

      issueData.segments.forEach((seg) => {
        const x1 = xScale(new Date(seg.startDate));
        const x2 = xScale(new Date(seg.endDate));
        const segWidth = x2 - x1;
        if (segWidth <= 0) return;

        const color = colorForSegment(seg);

        rowG.append('rect')
          .attr('class', seg.isUnconfigured ? 'segment segment--unconfigured' : 'segment')
          .attr('x', x1)
          .attr('y', ROW_PADDING)
          .attr('width', Math.max(segWidth, 1))
          .attr('height', BAR_HEIGHT)
          .attr('fill', color)
          .attr('rx', 2)
          .on('mouseover', function (event: MouseEvent) {
            showSegmentTooltip(event, seg);
          })
          .on('mousemove', function (event: MouseEvent) {
            moveTooltip(event);
          })
          .on('mouseout', function () {
            hideTooltip();
          });
      });
    });

    // ─── Indicators (markers/flags/hatches) — rendered AFTER status segments
    // so they always draw on top, one generic pass shared by every kind. ────
    rows.each(function (issueData) {
      const rowG = d3.select(this);
      const indicators = (issueData.indicators ?? []).filter((ind) => {
        if (!visibleIndicatorTypes) return true;
        if (!ind.semanticType) return true;
        return visibleIndicatorTypes.has(ind.semanticType);
      });
      if (indicators.length === 0) return;

      // Point-in-time indicators (marker + flag), sorted by date — needed so
      // the adaptive-label heuristic below can look at "the next indicator"
      // to decide how much horizontal room a flag's label has.
      const pointIndicators = indicators
        .filter((ind) => ind.kind !== 'hatch' && ind.date !== undefined)
        .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));

      indicators.forEach((indicator) => {
        const color = indicator.color ?? INDICATOR_DEFAULT_COLOR[indicator.kind];

        if (indicator.kind === 'hatch') {
          if (indicator.rangeStart === undefined || indicator.rangeEnd === undefined) return;
          const x1 = xScale(new Date(indicator.rangeStart));
          const x2 = xScale(new Date(indicator.rangeEnd));
          const w = x2 - x1;
          if (w <= 0) return;

          const hatchGroup = rowG.append('g')
            .attr('class', 'ish-indicator ish-indicator--hatch');

          // Fill rect: purely visual, deliberately NOT interactive
          // (pointer-events: none) so the light hatching never blocks
          // hovering the underlying status segments / other indicators in
          // the middle of a blocked period — per product spec, the tooltip
          // must only trigger on the boundary edges (hit rects below).
          hatchGroup.append('rect')
            .attr('x', x1)
            .attr('y', ROW_PADDING)
            .attr('width', w)
            .attr('height', BAR_HEIGHT)
            .attr('fill', `url(#${HATCH_PATTERN_ID})`)
            .attr('stroke', 'none')
            .attr('pointer-events', 'none');

          // Boundary hit rects + visible edge lines — one pair per edge
          // (rangeStart, rangeEnd), mirroring the marker/flag hit-rect
          // pattern: invisible wide hit rect carries the event handlers,
          // a thin visible line (pointer-events: none) shows where to hover.
          [indicator.rangeStart, indicator.rangeEnd].forEach((boundaryDate) => {
            const bx = xScale(new Date(boundaryDate as number));

            hatchGroup.append('rect')
              .attr('class', 'ish-indicator__hit')
              .attr('x', bx - INDICATOR_HIT_WIDTH / 2)
              .attr('y', 0)
              .attr('width', INDICATOR_HIT_WIDTH)
              .attr('height', ROW_HEIGHT)
              .attr('fill', 'transparent')
              .on('mouseover', function (event: MouseEvent) {
                showIndicatorTooltip(event, indicator);
              })
              .on('mousemove', function (event: MouseEvent) {
                moveTooltip(event);
              })
              .on('mouseout', function () {
                hideTooltip();
              });

            hatchGroup.append('line')
              .attr('x1', bx)
              .attr('x2', bx)
              .attr('y1', ROW_PADDING)
              .attr('y2', ROW_PADDING + BAR_HEIGHT)
              .attr('stroke', color)
              .attr('stroke-width', 1.5)
              .attr('pointer-events', 'none');
          });
          return;
        }

        if (indicator.date === undefined) return;
        const x = xScale(new Date(indicator.date));
        const cy = ROW_HEIGHT / 2;

        if (indicator.kind === 'marker') {
          const markerGroup = rowG.append('g')
            .attr('class', 'ish-indicator ish-indicator--marker');

          // Invisible wider hit-area — the visible tick is only 2px wide,
          // too thin to reliably hover. Event handlers live here so the
          // visible glyph can stay purely decorative (pointer-events: none).
          markerGroup.append('rect')
            .attr('class', 'ish-indicator__hit')
            .attr('x', x - INDICATOR_HIT_WIDTH / 2)
            .attr('y', 0)
            .attr('width', INDICATOR_HIT_WIDTH)
            .attr('height', ROW_HEIGHT)
            .attr('fill', 'transparent')
            .on('mouseover', function (event: MouseEvent) {
              showIndicatorTooltip(event, indicator);
            })
            .on('mousemove', function (event: MouseEvent) {
              moveTooltip(event);
            })
            .on('mouseout', function () {
              hideTooltip();
            });

          // Small vertical tick, centered in the row.
          markerGroup.append('line')
            .attr('x1', x)
            .attr('x2', x)
            .attr('y1', ROW_PADDING)
            .attr('y2', ROW_PADDING + BAR_HEIGHT)
            .attr('stroke', color)
            .attr('stroke-width', 2)
            .attr('pointer-events', 'none');
          return;
        }

        // kind === 'flag'
        const flagGroup = rowG.append('g')
          .attr('class', 'ish-indicator ish-indicator--flag');

        // Invisible wider hit-area covering the pole+pennant glyph. Widened
        // below to also cover any rendered inline label, so the whole
        // "glyph + label" visual reads as one hoverable target.
        const flagHitRect = flagGroup.append('rect')
          .attr('class', 'ish-indicator__hit')
          .attr('x', x - INDICATOR_HIT_WIDTH / 2)
          .attr('y', 0)
          .attr('width', INDICATOR_HIT_WIDTH)
          .attr('height', ROW_HEIGHT)
          .attr('fill', 'transparent');
        // (event handlers attached below, once the hit rect's final width —
        // which also needs to cover any rendered inline label — is known)

        // Flag glyph: a small triangle pennant on a short pole, anchored at
        // (x, cy). Cheap to draw as a single <path>, no external icon asset.
        // Purely decorative — pointer-events disabled, hit rects above/below
        // handle hover.
        const poleTopY = cy - BAR_HEIGHT / 2;
        const poleBottomY = cy + BAR_HEIGHT / 2;
        flagGroup.append('line')
          .attr('x1', x)
          .attr('x2', x)
          .attr('y1', poleTopY)
          .attr('y2', poleBottomY)
          .attr('stroke', color)
          .attr('stroke-width', 1.5)
          .attr('pointer-events', 'none');
        flagGroup.append('path')
          .attr('d', `M${x},${poleTopY} L${x + 8},${poleTopY + 3} L${x},${poleTopY + 6} Z`)
          .attr('fill', color)
          .attr('pointer-events', 'none');

        // ─── Adaptive inline label heuristic ────────────────────────────
        // Goal: show indicator.label next to the flag when there's enough
        // horizontal room, otherwise fall back to tooltip-only (or a
        // truncated label) so labels never visually collide.
        //
        // "Available room" = distance from this flag's x position to the
        // next point-in-time indicator on the SAME row (if any), or to the
        // right edge of the chart's plotted area otherwise. We estimate the
        // label's rendered width as `label.length * FLAG_LABEL_PX_PER_CHAR`
        // (a fixed px-per-character approximation — no canvas measureText,
        // per the task's "doesn't need to be pixel-perfect" allowance) and
        // require FLAG_LABEL_MIN_GAP px of breathing room beyond that.
        //   - Full label fits  -> render it in full.
        //   - Nothing fits (not even 1 char) -> skip the inline label
        //     entirely (tooltip still shows the full text on hover).
        //   - Partial fits -> truncate to the number of characters that
        //     fit, appending an ellipsis.
        if (indicator.label) {
          const myIndex = pointIndicators.findIndex((p) => p.id === indicator.id);
          const nextIndicator = myIndex >= 0 ? pointIndicators[myIndex + 1] : undefined;
          const rightBound = nextIndicator?.date !== undefined
            ? xScale(new Date(nextIndicator.date))
            : chartInnerWidth;
          const labelStartX = x + 10; // small gap after the flag glyph
          const availablePx = rightBound - labelStartX - FLAG_LABEL_MIN_GAP;

          const fullLabelPx = indicator.label.length * FLAG_LABEL_PX_PER_CHAR;
          let renderedLabel: string | null = null;
          if (availablePx >= fullLabelPx) {
            renderedLabel = indicator.label;
          } else {
            const maxChars = Math.floor(availablePx / FLAG_LABEL_PX_PER_CHAR) - 1; // reserve 1 char for "…"
            if (maxChars > 0) {
              renderedLabel = `${indicator.label.slice(0, maxChars)}…`;
            }
            // else: no room at all — inline label omitted, tooltip only.
          }

          if (renderedLabel) {
            flagGroup.append('text')
              .attr('class', 'ish-indicator__label')
              .attr('x', labelStartX)
              .attr('y', cy)
              .attr('dominant-baseline', 'middle')
              .attr('pointer-events', 'none')
              .text(renderedLabel);

            // Widen the hit rect to also cover the rendered label text
            // (estimated with the same px-per-char heuristic used to fit it).
            const labelPx = renderedLabel.length * FLAG_LABEL_PX_PER_CHAR;
            const hitLeft = x - INDICATOR_HIT_WIDTH / 2;
            const hitRight = labelStartX + labelPx + FLAG_LABEL_MIN_GAP;
            flagHitRect
              .attr('x', hitLeft)
              .attr('width', hitRight - hitLeft);
          }
        }

        // Event handlers attached last, once flagHitRect has its final
        // (possibly label-widened) size.
        flagHitRect
          .on('mouseover', function (event: MouseEvent) {
            showIndicatorTooltip(event, indicator);
          })
          .on('mousemove', function (event: MouseEvent) {
            moveTooltip(event);
          })
          .on('mouseout', function () {
            hideTooltip();
          });
      });
    });

  }, [data, debouncedWidth, statusOrder, baseUrl, gridStep, visibleIndicatorTypes]);

  if (data.length === 0) {
    return (
      <div className="ish-gantt-empty">
        No issues with state history found.
      </div>
    );
  }

  return (
    <div
      className="ish-gantt-wrapper"
      ref={containerRef}
      aria-label="Issue State History chart"
    >
      {/* Legend */}
      <div className="ish-gantt-legend">
        {statusOrder.map((s, i) => (
          <div key={s.id} className="ish-gantt-legend__item">
            <span
              className="ish-gantt-legend__dot"
              style={{ background: s.color ?? STATUS_COLORS[i % STATUS_COLORS.length] }}
            />
            <span className="ish-gantt-legend__label">{s.name}</span>
          </div>
        ))}
        <div className="ish-gantt-legend__item">
          <span
            className="ish-gantt-legend__dot"
            style={{ background: UNCONFIGURED_COLOR }}
          />
          <span className="ish-gantt-legend__label">Other/Unconfigured</span>
        </div>
      </div>

      {/* Outer vertical-scroll owner: both panes scroll together as a unit. */}
      <div className="ish-gantt-vscroll">
        <div className="ish-gantt-panes">
          {/* Frozen labels pane: fixed width, no horizontal scroll. */}
          <div className="ish-gantt-labels-pane" style={{ width: LABELS_WIDTH }}>
            <svg
              ref={labelsSvgRef}
              className="ish-gantt-labels-svg"
              role="img"
              aria-label="Issue ID labels"
            />
          </div>

          {/* Scrollable chart pane: horizontal scroll only. */}
          <div className="ish-gantt-scroll" ref={scrollRef}>
            <svg
              ref={svgRef}
              className="ish-gantt-svg"
              role="img"
              aria-label={`Issue State History Gantt chart showing ${data.length} issues`}
            />
          </div>
        </div>
      </div>

      {/* Tooltip */}
      <div ref={tooltipRef} className="ish-gantt-tooltip" style={{ display: 'none' }} />
    </div>
  );
}
