import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { IssueChartData, EstimateDateChange, LtSettings, StatusOrderItem } from './types';
import './gantt-chart.css';

interface GanttChartProps {
  data: IssueChartData[];
  statusOrder: StatusOrderItem[];
  ltEnabled: boolean;
  ltSettings: LtSettings;
  showEstimateDate: boolean;
  showProjectedLT: boolean;
  baseUrl: string;
}

// ─── Layout constants ─────────────────────────────────────────────────────────
const MARGIN = { top: 20, right: 20, bottom: 40, left: 110 };
const ROW_HEIGHT = 28;
const ROW_PADDING = 4;
const BAR_HEIGHT = ROW_HEIGHT - ROW_PADDING * 2;
const TICK_WIDTH = 2;
const TICK_HEIGHT = BAR_HEIGHT;
const MIN_CHART_WIDTH = 400;

// ─── Color palette for statuses (fallback if no color from API) ───────────────
const STATUS_COLORS = [
  '#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336',
  '#00BCD4', '#8BC34A', '#FF5722', '#607D8B', '#E91E63',
];

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
  ltEnabled,
  ltSettings,
  showEstimateDate,
  showProjectedLT,
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

    const formatDate = (ts: number | null) =>
      ts ? new Date(ts).toLocaleDateString() : '—';

    const showTooltip = (event: MouseEvent, change: EstimateDateChange, tickNum: number) => {
      if (!tooltipEl) return;
      tooltipEl.innerHTML = buildTooltipHtml(`Estimate change #${tickNum}`, [
        { label: 'Date', value: new Date(change.changedAt).toLocaleString() },
        { label: 'Was', value: formatDate(change.fromDate) },
        { label: 'Became', value: formatDate(change.toDate) },
        { label: 'By', value: change.author },
      ]);
      tooltipEl.style.display = 'block';
      moveTooltip(event);
    };

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
    const maxDays = Math.max(maxTotalDays, maxProjectedDays);
    const xDomain: [number, number] = [0, maxDays * 1.05];
    const xScale = d3.scaleLinear().domain(xDomain).range([0, chartWidth]);

    // ─── Y scale (issues) ────────────────────────────────────────────────────
    const yScale = d3.scaleBand()
      .domain(data.map((d) => d.issueId))
      .range([0, chartHeight])
      .padding(0);

    // ─── Grid lines ──────────────────────────────────────────────────────────
    const tickCount = Math.min(10, Math.floor(chartWidth / 60));

    const xAxis = d3.axisBottom(xScale)
      .ticks(tickCount)
      .tickFormat((d) => `${d}d`);

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
        const color =
          statusColorMap.get(seg.statusId) ??
          statusColorMap.get(seg.statusName.toLowerCase()) ??
          seg.color ??
          STATUS_COLORS[segIdx % STATUS_COLORS.length];

        rowG.append('rect')
          .attr('class', 'segment')
          .attr('x', xOffset)
          .attr('y', ROW_PADDING)
          .attr('width', Math.max(segWidth, 1))
          .attr('height', BAR_HEIGHT)
          .attr('fill', color)
          .attr('rx', 2)
          .append('title')
          .text(`${seg.statusName}: ${seg.durationDays.toFixed(1)} days`);

        xOffset += segWidth;
      });
    });

    // ─── Estimate date ticks ──────────────────────────────────────────────────
    if (showEstimateDate) {
      rows.each(function (issueData) {
        if (issueData.estimateDateChanges.length === 0) return;

        const rowG = d3.select(this);
        // Use issueData.createdAt if available; fall back to deriving from totalDays
        const issueCreatedAt = issueData.createdAt ?? (
          issueData.totalDays > 0
            ? Date.now() - issueData.totalDays * 24 * 60 * 60 * 1000
            : Date.now()
        );

        issueData.estimateDateChanges.forEach((change, idx) => {
          const daysSinceCreation = (change.changedAt - issueCreatedAt) / (24 * 60 * 60 * 1000);
          const tickX = xScale(Math.max(0, daysSinceCreation));

          rowG.append('line')
            .attr('class', 'estimate-tick')
            .attr('x1', tickX)
            .attr('x2', tickX)
            .attr('y1', ROW_PADDING)
            .attr('y2', ROW_PADDING + TICK_HEIGHT)
            .attr('stroke', 'var(--ring-text-color)')
            .attr('stroke-width', TICK_WIDTH)
            .attr('opacity', 0.8);

          const isLast = idx === issueData.estimateDateChanges.length - 1;
          const dateToShow = change.toDate ?? change.fromDate;
          const labelText = isLast && dateToShow !== null
            ? new Date(dateToShow).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })
            : String(idx + 1);

          rowG.append('text')
            .attr('class', 'estimate-tick-label')
            .attr('x', tickX + 3)
            .attr('y', ROW_PADDING + 10)
            .attr('font-size', '9px')
            .attr('fill', 'var(--ring-text-color)')
            .text(labelText);

          // Capture change and idx for closure
          const capturedChange = change;
          const capturedTickNum = idx + 1;

          rowG.append('rect')
            .attr('class', 'estimate-tick-target')
            .attr('x', tickX - 6)
            .attr('y', ROW_PADDING)
            .attr('width', 12)
            .attr('height', TICK_HEIGHT)
            .attr('fill', 'transparent')
            .attr('cursor', 'pointer')
            .on('mouseover', function (event: MouseEvent) {
              showTooltip(event, capturedChange, capturedTickNum);
            })
            .on('mousemove', function (event: MouseEvent) {
              moveTooltip(event);
            })
            .on('mouseout', function () {
              hideTooltip();
            });
        });
      });
    }

    // ─── LT threshold markers (per-row vertical lines + labels for LT50% and LT80%) ───
    if (ltEnabled) {
      const showLtTooltip = (
        event: MouseEvent,
        issueType: string | undefined,
        label: string,
        days: number
      ) => {
        if (!tooltipEl) return;
        const weeksStr = days > 28 ? ` (${Math.round(days / 7)} weeks)` : '';
        const rows: { label: string; value: string }[] = [];
        if (issueType) {
          rows.push({ label: 'Type', value: issueType });
        }
        rows.push({ label, value: `${days} days${weeksStr}` });
        tooltipEl.innerHTML = buildTooltipHtml(`${label} Threshold`, rows);
        tooltipEl.style.display = 'block';
        moveTooltip(event);
      };

      rows.each(function (issueData) {
        const typeName = issueData.issueType ?? '';
        const lt = ltSettings[typeName] ?? ltSettings[''];
        if (!lt) return;

        const rowG = d3.select(this);

        const renderLtMarker = (
          days: number,
          color: string,
          cssClass: string,
          label: string
        ) => {
          const tickX = xScale(days);
          const capturedDays = days;
          const capturedLabel = label;
          const capturedType = issueData.issueType;

          rowG.append('line')
            .attr('class', `lt-threshold-tick ${cssClass}`)
            .attr('x1', tickX)
            .attr('x2', tickX)
            .attr('y1', ROW_PADDING)
            .attr('y2', ROW_PADDING + TICK_HEIGHT)
            .attr('stroke', color)
            .attr('stroke-width', TICK_WIDTH)
            .attr('opacity', 0.9);

          rowG.append('text')
            .attr('class', `lt-threshold-tick-label ${cssClass}-label`)
            .attr('x', tickX + 3)
            .attr('y', ROW_PADDING + 10)
            .attr('font-size', '9px')
            .attr('fill', color)
            .text(label);

          rowG.append('rect')
            .attr('class', 'lt-threshold-tick-target')
            .attr('x', tickX - 6)
            .attr('y', ROW_PADDING)
            .attr('width', 12)
            .attr('height', TICK_HEIGHT)
            .attr('fill', 'transparent')
            .attr('cursor', 'pointer')
            .on('mouseover', function (event: MouseEvent) {
              showLtTooltip(event, capturedType, capturedLabel, capturedDays);
            })
            .on('mousemove', function (event: MouseEvent) {
              moveTooltip(event);
            })
            .on('mouseout', function () {
              hideTooltip();
            });
        };

        if (lt.lt50 !== undefined) {
          renderLtMarker(lt.lt50, '#FFA500', 'lt-threshold-tick-lt50', 'LT50%');
        }
        if (lt.lt80 !== undefined) {
          renderLtMarker(lt.lt80, '#FF0000', 'lt-threshold-tick-lt80', 'LT80%');
        }
      });
    }

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
          const days = issueData.projectedLeadTimeDays;
          const ltStr = days > 28
            ? `${Math.round(days / 7)}w`
            : `${Math.round(days)}d`;
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
    });

  }, [data, debouncedWidth, ltEnabled, ltSettings, showEstimateDate, showProjectedLT, statusOrder, baseUrl]);

  // ─── Legend ──────────────────────────────────────────────────────────────────
  if (data.length === 0) {
    return (
      <div className="ip-gantt-empty">
        No issues with state history found.
      </div>
    );
  }

  const useHorizontalScroll = containerWidth < MIN_CHART_WIDTH;

  return (
    <div
      className="ip-gantt-wrapper"
      ref={containerRef}
      aria-label="Issues Progress chart"
    >
      {/* Legend */}
      {statusOrder.length > 0 && (
        <div className="ip-gantt-legend">
          {statusOrder.map((s, i) => (
            <div key={s.id} className="ip-gantt-legend__item">
              <span
                className="ip-gantt-legend__dot"
                style={{ background: s.color ?? STATUS_COLORS[i % STATUS_COLORS.length] }}
              />
              <span className="ip-gantt-legend__label">{s.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Chart scroll container */}
      <div
        className="ip-gantt-scroll"
        style={{ overflowX: useHorizontalScroll ? 'auto' : 'hidden' }}
      >
        <svg
          ref={svgRef}
          className="ip-gantt-svg"
          role="img"
          aria-label={`Issues Progress Gantt chart showing ${data.length} issues`}
        />
      </div>

      {/* Tooltip */}
      <div ref={tooltipRef} className="ip-gantt-tooltip" style={{ display: 'none' }} />
    </div>
  );
}
