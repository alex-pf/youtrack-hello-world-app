import React from 'react';
import { IssueChartData, StatusOrderItem, GridStep } from './types';
import GanttChart, { STATUS_COLORS, UNCONFIGURED_COLOR } from './gantt-chart';
import './gantt-chart.css';

interface GroupedGanttChartProps {
  groups: Map<string, IssueChartData[]>;                     // from groupChartData(), keys already alphabetical
  percentilesByGroup: Map<string, { p50: number; p80: number } | null>;
  statusOrder: StatusOrderItem[];
  showProjectedLT: boolean;
  gridStep: GridStep;
  baseUrl: string;
  groupFieldLabel?: string; // optional label prefix for the section title, e.g. "Type"
}

export default function GroupedGanttChart({
  groups,
  percentilesByGroup,
  statusOrder,
  showProjectedLT,
  gridStep,
  baseUrl,
  groupFieldLabel,
}: GroupedGanttChartProps) {
  if (groups.size === 0) {
    return (
      <div className="ip-gantt-empty">
        No issues found.
      </div>
    );
  }

  return (
    <div className="ip-gantt-wrapper" aria-label="Progress Tracking grouped charts">
      {/* Shared legend — Status Order is common to all group charts */}
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
          <div className="ip-gantt-legend__item">
            <span
              className="ip-gantt-legend__dot"
              style={{ background: UNCONFIGURED_COLOR }}
            />
            <span className="ip-gantt-legend__label">Other</span>
          </div>
        </div>
      )}

      <div className="ip-groups-scroll">
        {Array.from(groups.entries()).map(([groupKey, items]) => {
          const displayValue = groupKey || '(без значения)';
          const title = groupFieldLabel
            ? `${groupFieldLabel}: ${displayValue} (${items.length})`
            : `${displayValue} (${items.length})`;

          return (
            <div className="ip-group-section" key={groupKey}>
              <div className="ip-group-section__title">{title}</div>
              <GanttChart
                data={items}
                statusOrder={statusOrder}
                showProjectedLT={showProjectedLT}
                gridStep={gridStep}
                percentiles={percentilesByGroup.get(groupKey) ?? null}
                baseUrl={baseUrl}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
