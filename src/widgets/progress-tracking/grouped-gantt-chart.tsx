import React from 'react';
import { IssueChartData, StatusOrderItem, GridStep } from './types';
import GanttChart, { STATUS_COLORS, UNCONFIGURED_COLOR, formatLeadTimeDays } from './gantt-chart';
import './gantt-chart.css';

interface GroupedGanttChartProps {
  groups: Map<string, IssueChartData[]>;                     // from groupChartData(), keys already alphabetical
  percentilesByGroup: Map<string, { p50: number; p80: number } | null>;
  statusOrder: StatusOrderItem[];
  showProjectedLT: boolean;
  gridStep: GridStep;
  baseUrl: string;
  groupFieldLabel?: string; // optional label prefix for the section title, e.g. "Type"
  percentileStageName?: string; // name of the stage currently driving the percentile zones, for the title's LT summary
}

export default function GroupedGanttChart({
  groups,
  percentilesByGroup,
  statusOrder,
  showProjectedLT,
  gridStep,
  baseUrl,
  groupFieldLabel,
  percentileStageName,
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
          const baseTitle = groupFieldLabel
            ? `${groupFieldLabel}: ${displayValue} (${items.length})`
            : `${displayValue} (${items.length})`;

          // LT summary for the stage currently driving the percentile
          // background zones — omitted when no stage is selected/active, or
          // when this group has no resolved-issue sample for it (percentiles
          // === null, e.g. no issue in the group ever reached the stage).
          const percentiles = percentilesByGroup.get(groupKey) ?? null;
          const title = percentileStageName && percentiles
            ? `${baseTitle} LT этапа ${percentileStageName}: 50% - ${formatLeadTimeDays(percentiles.p50)}, 80% - ${formatLeadTimeDays(percentiles.p80)}`
            : baseTitle;

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
