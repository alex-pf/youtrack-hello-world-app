import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { IssueStateHistoryData, DateSegment, StatusOrderItem } from './types';
import './gantt-chart.css';

interface GanttChartProps {
  data: IssueStateHistoryData[];
  statusOrder: StatusOrderItem[];
  baseUrl: string;
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
// Minimum horizontal pixels allotted per calendar day in the scrollable chart
// pane. Chosen so that date tick labels ("01 Jan 26") formatted at typical
// tick density (one tick roughly every 90px, see tickCount below) remain
// legible without overlapping, while keeping short date ranges (a few weeks)
// from becoming needlessly wide. At 12px/day, a ~7-day tick spacing yields
// ~84px between ticks, close to the 90px axis label spacing used elsewhere.
// This is a heuristic and may need Lead/design tuning once tested against
// real multi-month date ranges.
const MIN_PX_PER_DAY = 12;

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

export default function GanttChart({ data, statusOrder, baseUrl }: GanttChartProps) {
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
    const domainDays = (xDomain[1].getTime() - xDomain[0].getTime()) / DAY_MS;

    // ─── Chart pane width: driven by date range, never narrower than the
    // available scroll-pane space (containerWidth minus the frozen labels
    // pane and the chart's own left/right margins). This is what makes the
    // chart overflow (and the horizontal scrollbar appear) when the date
    // range is wide, instead of always being compressed to fit. ───────────
    const availableWidth = Math.max(containerWidth - LABELS_WIDTH, MIN_CHART_WIDTH - LABELS_WIDTH);
    const chartInnerWidth = Math.max(domainDays * MIN_PX_PER_DAY, availableWidth - MARGIN.left - MARGIN.right);
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

    const g = svg
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    // ─── Axis + grid lines ───────────────────────────────────────────────────
    const tickCount = Math.max(2, Math.min(Math.ceil(domainDays), Math.floor(chartInnerWidth / 90)));

    const xAxis = d3.axisBottom<Date>(xScale)
      .ticks(tickCount)
      .tickFormat((d) => d3.timeFormat('%d %b %y')(d as Date));

    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0,${chartHeight})`)
      .call(xAxis);

    g.append('g')
      .attr('class', 'grid-lines')
      .selectAll('line')
      .data(xScale.ticks(tickCount))
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

  }, [data, containerWidth, debouncedWidth, statusOrder, baseUrl]);

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
