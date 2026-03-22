import React, {memo, useMemo, useState, useCallback} from 'react';
import type {Issue, IssueField, IssueFieldValue, FieldColumnConfig} from './types';
import './issues-table.css';

interface Props {
  issues: Issue[];
  baseUrl: string;
  visibleFields?: FieldColumnConfig[];
}

type SortDir = 'asc' | 'desc';

interface SortState {
  key: string;
  dir: SortDir;
}

/* ---- helpers (reused from issue-line logic) ---- */

function toArray(value: IssueFieldValue | IssueFieldValue[] | null): IssueFieldValue[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getName(value: IssueFieldValue): string {
  return value.localizedName || value.name || '';
}

function isColoredValue(v: IssueFieldValue): boolean {
  return !!(v.color && v.color.id > 0);
}

function formatTimestamp(ts: number, withTime = false): string {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  if (!withTime) return `${day}.${month}.${year}`;
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${mins}`;
}

function getFieldPresentation(field: IssueField): string {
  const valueType = field.projectCustomField?.field?.fieldType?.valueType || '';
  return toArray(field.value).map(v => {
    if (valueType.indexOf('date') > -1) {
      const ts = v as unknown as number;
      if (typeof ts === 'number' && ts > 0) {
        return formatTimestamp(ts, valueType.indexOf('time') > -1);
      }
    }
    return getName(v) || v.presentation || (v.minutes ? `${v.minutes}m` : '') || v.login || '';
  }).filter(Boolean).join(', ');
}

function getFieldColor(field: IssueField) {
  const first = toArray(field.value)[0];
  if (first && isColoredValue(first) && first.color) {
    return {background: first.color.background, color: first.color.foreground};
  }
  return null;
}

/** Get the value of a column for a given issue */
function getCellValue(issue: Issue, col: FieldColumnConfig): string | null {
  if (col.key === 'id') return issue.idReadable;
  if (col.key === 'summary') return issue.summary;
  if (col.builtin) {
    const ts = col.key === 'created' ? issue.created : col.key === 'updated' ? issue.updated : null;
    return ts && ts > 0 ? formatTimestamp(ts, true) : null;
  }
  const f = (issue.fields || []).find(
    fld => fld.projectCustomField?.field?.name === col.key
  );
  if (!f) return null;
  return getFieldPresentation(f) || null;
}

/** Numeric sort key for a column — used to sort numbers/dates properly */
function getSortKey(issue: Issue, col: FieldColumnConfig): string | number {
  if (col.key === 'id') return issue.idReadable;
  if (col.key === 'summary') return issue.summary.toLowerCase();
  if (col.builtin) {
    const ts = col.key === 'created' ? issue.created : col.key === 'updated' ? issue.updated : null;
    return ts ?? 0;
  }
  const f = (issue.fields || []).find(
    fld => fld.projectCustomField?.field?.name === col.key
  );
  if (!f) return '';
  const valueType = f.projectCustomField?.field?.fieldType?.valueType || '';
  // Date fields — sort by timestamp
  if (valueType.indexOf('date') > -1) {
    const v = toArray(f.value)[0];
    const ts = v as unknown as number;
    return typeof ts === 'number' ? ts : 0;
  }
  // Period fields — sort by minutes
  const first = toArray(f.value)[0];
  if (first?.minutes !== undefined) return first.minutes;
  // Everything else — sort by text
  return (getFieldPresentation(f) || '').toLowerCase();
}

/* ---- component ---- */

const FIXED_COLUMNS: FieldColumnConfig[] = [
  {key: 'id', label: 'ID'},
  {key: 'summary', label: 'Описание'},
];

const IssuesTableComponent: React.FC<Props> = ({issues, baseUrl, visibleFields}) => {
  const [sort, setSort] = useState<SortState | null>(null);

  const columns = useMemo<FieldColumnConfig[]>(() => {
    return [...FIXED_COLUMNS, ...(visibleFields || [])];
  }, [visibleFields]);

  const handleSort = useCallback((key: string) => {
    setSort(prev => {
      if (prev?.key === key) {
        return prev.dir === 'asc' ? {key, dir: 'desc'} : null;
      }
      return {key, dir: 'asc'};
    });
  }, []);

  const sortedIssues = useMemo(() => {
    if (!sort) return issues;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return issues;
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...issues].sort((a, b) => {
      const ka = getSortKey(a, col);
      const kb = getSortKey(b, col);
      if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * mult;
      return String(ka).localeCompare(String(kb), 'ru') * mult;
    });
  }, [issues, sort, columns]);

  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  return (
    <div className="it-wrapper">
      <table className="it-table">
        <thead>
          <tr>
            {columns.map(col => {
              const isActive = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  className={`it-th ${isActive ? 'it-th--active' : ''}`}
                  onClick={() => handleSort(col.key)}
                >
                  <span className="it-th-content">
                    {col.label}
                    {isActive && (
                      <span className="it-sort-icon">
                        {sort!.dir === 'asc' ? '▲' : '▼'}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedIssues.map(issue => {
            const isResolved = issue.resolved != null;
            const issueUrl = `${normalizedUrl}issue/${issue.idReadable}`;
            return (
              <tr key={issue.id} className="it-row">
                {columns.map(col => {
                  if (col.key === 'id') {
                    return (
                      <td key="id" className="it-td">
                        <a
                          className={`it-issue-id ${isResolved ? 'it-issue-id--resolved' : ''}`}
                          href={issueUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {issue.idReadable}
                        </a>
                      </td>
                    );
                  }
                  if (col.key === 'summary') {
                    return (
                      <td key="summary" className="it-td it-td--summary">
                        <a
                          className={`it-summary ${isResolved ? 'it-summary--resolved' : ''}`}
                          href={issueUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {issue.summary}
                        </a>
                      </td>
                    );
                  }
                  // Custom / built-in field
                  const val = getCellValue(issue, col);
                  if (!val) return <td key={col.key} className="it-td">—</td>;

                  // Check for color
                  if (!col.builtin) {
                    const f = (issue.fields || []).find(
                      fld => fld.projectCustomField?.field?.name === col.key
                    );
                    if (f) {
                      const color = getFieldColor(f);
                      if (color) {
                        return (
                          <td key={col.key} className="it-td">
                            <span className="it-color-badge" style={color}>{val}</span>
                          </td>
                        );
                      }
                    }
                  }
                  return <td key={col.key} className="it-td">{val}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export const IssuesTable = memo(IssuesTableComponent);
