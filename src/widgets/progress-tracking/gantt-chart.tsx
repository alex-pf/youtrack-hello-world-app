import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { IssueChartData, StatusOrderItem, GridStep } from './types';
import './gantt-chart.css';

interface GanttChartProps {
  data: IssueChartData[];          // issues of this ONE group, already sorted by the caller
  statusOrder: StatusOrderItem[];
  showProjectedLT: boolean;
  gridStep: GridStep;               // days between grid ticks — shared across all group charts
  percentiles: { p50: number; p80: number } | null; // null → no background zones (group has no resolved issues)
  baseUrl: string;
}

// ─── Layout constants ─────────────────────────────────────────────────────────
const MARGIN = { top: 20, right: 20, bottom: 40, left: 110 };
const ROW_HEIGHT = 28;
const ROW_PADDING = 4;
const BAR_HEIGHT = ROW_HEIGHT - ROW_PADDING * 2;
const TICK_HEIGHT = BAR_HEIGHT;
const MIN_CHART_WIDTH = 400;

// ─── Color palette for statuses (fallback if no color from API) ───────────────
export const STATUS_COLORS = [
  '#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336',
  '#00BCD4', '#8BC34A', '#FF5722', '#607D8B', '#E91E63',
];

// Fixed gray used ONLY for segments whose status is not present in the
// configured statusOrder (isUnconfigured === true). Deliberate "unknown
// status" signal — must never be reused as a fallback palette color for
// configured-but-colorless statuses.
export const UNCONFIGURED_COLOR = '#9E9E9E';

// Formats a lead-time day count as "Nd" (≤28 days) or "Nw" (>28 days,
// rounded to whole weeks) — shared between the Projected LT marker label and
// the group section title's LT summary, so the two never drift apart.
export function formatLeadTimeDays(days: number): string {
  return days > 28 ? `${Math.round(days / 7)}w` : `${Math.round(days)}d`;
}

// ─── XSS-safe tooltip builder ─────────────────────────────────────────────────
function buildTooltipHtml(title: string, rows: { label: string; value: string }[]): string {
  const escHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rowsHtml = rows
    .map(
      (r) =>
        `<div class="ip-gantt-tooltip__row"><span class="ip-gantt-tooltip__label">${escHtml(r.label)}:</span><span>${escHtml(r.value)}</span></div>`
    )
    .join('');
  return `<div class="ip-gantt-tooltip__header">${escHtml(title)}</div>${rowsHtml}`;
}

export default function GanttChart({
  data,
  statusOrder,
  showProjectedLT,
  gridStep,
  percentiles,
  baseUrl,
}: GanttChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
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
    if (!svgRef.current || data.length === 0) return;

    // ─── Tooltip helpers (inlined to avoid stale closure) ──────────────────
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

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const effectiveWidth = Math.max(debouncedWidth, MIN_CHART_WIDTH);
    const chartWidth = effectiveWidth - MARGIN.left - MARGIN.right;
    const chartHeight = data.length * ROW_HEIGHT;
    const totalHeight = chartHeight + MARGIN.top + MARGIN.bottom;

    svg
      .attr('width', effectiveWidth)
      .attr('height', totalHeight)
      .attr('aria-label', `Gantt chart: ${data.length} issues`);

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    // ─── X scale (days) ──────────────────────────────────────────────────────
    const maxTotalDays = d3.max(data, (d) => d.totalDays) ?? 30;
    const maxProjectedDays = showProjectedLT
      ? (d3.max(data, (d) => d.projectedLeadTimeDays ?? 0) ?? 0)
      : 0;
    const maxDays = Math.max(maxTotalDays, maxProjectedDays, percentiles?.p80 ?? 0);
    const xDomain: [number, number] = [0, maxDays * 1.05];
    const xScale = d3.scaleLinear().domain(xDomain).range([0, chartWidth]);

    // ─── Y scale (issues) ────────────────────────────────────────────────────
    const yScale = d3.scaleBand()
      .domain(data.map((d) => d.issueId))
      .range([0, chartHeight])
      .padding(0);

    // ─── Percentile background zones (drawn first so rows/segments sit on top) ──
    if (percentiles !== null) {
      const p50X = xScale(percentiles.p50);
      const p80X = xScale(percentiles.p80);

      const zones: { x0: number; x1: number; cls: string }[] = [
        { x0: 0, x1: p50X, cls: 'percentile-zone--green' },
        { x0: p50X, x1: p80X, cls: 'percentile-zone--yellow' },
        { x0: p80X, x1: chartWidth, cls: 'percentile-zone--red' },
      ];

      const zonesG = g.append('g').attr('class', 'percentile-zones');
      zones.forEach((z) => {
        const width = Math.max(z.x1 - z.x0, 0);
        if (width <= 0) return;
        zonesG.append('rect')
          .attr('class', `percentile-zone ${z.cls}`)
          .attr('x', z.x0)
          .attr('y', 0)
          .attr('width', width)
          .attr('height', chartHeight)
          .attr('pointer-events', 'none');
      });
    }

    // ─── Grid lines / X axis — ticks aligned to multiples of gridStep ────────
    const maxDomain = xDomain[1];
    const tickValues: number[] = [];
    for (let t = 0; t <= maxDomain; t += gridStep) tickValues.push(t);

    const xAxis = d3.axisBottom(xScale)
      .tickValues(tickValues)
      .tickFormat((d) => `${d}d`);

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
    const statusColorMap = new Map<string, string>();
    statusOrder.forEach((s, i) => {
      if (s.color) {
        statusColorMap.set(s.id, s.color);
        statusColorMap.set(s.name.toLowerCase(), s.color);
      } else {
        const fallback = STATUS_COLORS[i % STATUS_COLORS.length];
        statusColorMap.set(s.id, fallback);
        statusColorMap.set(s.name.toLowerCase(), fallback);
      }
    });

    // ─── Issue rows ───────────────────────────────────────────────────────────
    const rows = g.selectAll<SVGGElement, IssueChartData>('.issue-row')
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
      .attr('width', chartWidth)
      .attr('height', ROW_HEIGHT)
      .attr('fill', 'transparent')
      .on('mouseover', function () {
        d3.select(this).attr('fill', 'var(--ring-hover-background-color)');
      })
      .on('mouseout', function () {
        d3.select(this).attr('fill', 'transparent');
      });

    // ─── Status segments (stacked horizontal bars) ────────────────────────────
    rows.each(function (issueData) {
      const rowG = d3.select(this);
      let xOffset = 0;

      issueData.segments.forEach((seg, segIdx) => {
        if (seg.durationDays <= 0) return;

        const segWidth = xScale(seg.durationDays) - xScale(0);
        const color = seg.isUnconfigured
          ? UNCONFIGURED_COLOR
          : statusColorMap.get(seg.statusId) ??
            statusColorMap.get(seg.statusName.toLowerCase()) ??
            seg.color ??
            STATUS_COLORS[segIdx % STATUS_COLORS.length];
        const tooltipText = seg.isUnconfigured
          ? `${seg.statusName} (not in configured status list): ${seg.durationDays.toFixed(1)} days`
          : `${seg.statusName}: ${seg.durationDays.toFixed(1)} days`;

        rowG.append('rect')
          .attr('class', 'segment')
          .attr('x', xOffset)
          .attr('y', ROW_PADDING)
          .attr('width', Math.max(segWidth, 1))
          .attr('height', BAR_HEIGHT)
          .attr('fill', color)
          .attr('rx', 2)
          .append('title')
          .text(tooltipText);

        xOffset += segWidth;
      });
    });

    // ─── Projected Lead Time marker (current Estimated Date, unchanged algorithm) ──
    if (showProjectedLT) {
      rows.each(function (issueData) {
        if (!issueData.projectedLeadTimeDays || issueData.projectedLeadTimeDays <= 0) return;

        const rowG = d3.select(this);
        const tickX = xScale(issueData.projectedLeadTimeDays);

        const estimatedDate = issueData.projectedLTDate ?? null;

        rowG.append('line')
          .attr('class', 'projected-lt-marker')
          .attr('x1', tickX)
          .attr('x2', tickX)
          .attr('y1', ROW_PADDING)
          .attr('y2', ROW_PADDING + TICK_HEIGHT)
          .attr('stroke', '#22C55E')
          .attr('stroke-width', 2.5)
          .attr('opacity', 0.95);

        if (estimatedDate !== null) {
          const dateStr = new Date(estimatedDate).toLocaleDateString(undefined, {
            day: '2-digit', month: '2-digit', year: '2-digit',
          });
          const ltStr = formatLeadTimeDays(issueData.projectedLeadTimeDays);
          const labelText = `LT-${ltStr}; ${dateStr}`;
          const estimatedLabelWidth = labelText.length * 5.4;
          const labelX = tickX + estimatedLabelWidth + 4 > chartWidth
            ? tickX - estimatedLabelWidth - 4
            : tickX + 4;
          rowG.append('text')
            .attr('class', 'projected-lt-marker-label')
            .attr('x', labelX)
            .attr('y', ROW_PADDING + TICK_HEIGHT)
            .attr('font-size', '9px')
            .attr('fill', '#22C55E')
            .attr('font-weight', 'bold')
            .text(labelText);
        }

        const capturedDays = issueData.projectedLeadTimeDays;
        const capturedDate = estimatedDate;
        rowG.append('rect')
          .attr('class', 'projected-lt-marker-target')
          .attr('x', tickX - 6)
          .attr('y', ROW_PADDING)
          .attr('width', 12)
          .attr('height', TICK_HEIGHT)
          .attr('fill', 'transparent')
          .attr('cursor', 'pointer')
          .on('mouseover', function (event: MouseEvent) {
            if (!tooltipEl) return;
            const dateStr = capturedDate ? new Date(capturedDate).toLocaleDateString() : '—';
            tooltipEl.innerHTML = buildTooltipHtml('Projected Lead Time', [
              { label: 'Days', value: capturedDays.toFixed(1) },
              { label: 'Estimated Date', value: dateStr },
            ]);
            tooltipEl.style.display = 'block';
            moveTooltip(event);
          })
          .on('mousemove', function (event: MouseEvent) { moveTooltip(event); })
          .on('mouseout', function () { hideTooltip(); });
      });
    }

    // ─── Y axis (issue IDs as clickable links via foreignObject) ─────────────
    const yAxisG = g.append('g').attr('class', 'y-axis');

    data.forEach((issueData) => {
      const y = yScale(issueData.issueId) ?? 0;
      const issueUrl = `${baseUrl}/issue/${issueData.idReadable}`;

      yAxisG.append('foreignObject')
        .attr('x', -MARGIN.left)
        .attr('y', y + ROW_PADDING)
        .attr('width', MARGIN.left - 4)
        .attr('height', BAR_HEIGHT)
        // `as any` is required because D3's TypeScript types do not include the
        // xhtml: namespace prefix needed to render an <a> element inside SVG
        // foreignObject. The xhtml: prefix is the correct W3C way to embed HTML
        // elements in SVG, but @types/d3 only exposes standard SVG element names.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .append('xhtml:a' as any)
        .attr('href', issueUrl)
        .attr('target', '_blank')
        .attr('rel', 'noopener noreferrer')
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
        .text(issueData.idReadable)
        .on('mouseover', function (event: MouseEvent) {
          if (!tooltipEl) return;
          tooltipEl.innerHTML = buildTooltipHtml(issueData.idReadable, [
            { label: 'Название', value: issueData.summary },
            { label: 'LT', value: `${issueData.totalDays.toFixed(1)} дн.` },
          ]);
          tooltipEl.style.display = 'block';
          moveTooltip(event);
        })
        .on('mousemove', function (event: MouseEvent) { moveTooltip(event); })
        .on('mouseout', function () { hideTooltip(); });
    });

  }, [data, debouncedWidth, showProjectedLT, gridStep, percentiles, statusOrder, baseUrl]);

  if (data.length === 0) {
    return (
      <div className="ip-gantt-empty">
        No issues found.
      </div>
    );
  }

  const useHorizontalScroll = containerWidth < MIN_CHART_WIDTH;

  return (
    <div
      className="ip-gantt-wrapper"
      ref={containerRef}
      aria-label="Progress Tracking chart"
    >
      {/* Chart scroll container */}
      <div
        className="ip-gantt-scroll"
        style={{ overflowX: useHorizontalScroll ? 'auto' : 'hidden' }}
      >
        <svg
          ref={svgRef}
          className="ip-gantt-svg"
          role="img"
          aria-label={`Progress Tracking Gantt chart showing ${data.length} issues`}
        />
      </div>

      {/* Tooltip */}
      <div ref={tooltipRef} className="ip-gantt-tooltip" style={{ display: 'none' }} />
    </div>
  );
}
