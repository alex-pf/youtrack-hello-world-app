import React, {memo} from 'react';
import type {Issue, IssueField, IssueFieldValue, FieldColumnConfig} from './types';
import './issue-line.css';

interface Props {
  issue: Issue;
  baseUrl: string;
  visibleFields?: FieldColumnConfig[];
}

function toArray(value: IssueFieldValue | IssueFieldValue[] | null): IssueFieldValue[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getName(value: IssueFieldValue): string {
  return value.localizedName || value.name || '';
}

function isColoredValue(value: IssueFieldValue): boolean {
  return !!(value.color && value.color.id > 0);
}

function getColoredSquare(issue: Issue) {
  const bundleFields = (issue.fields || []).filter(
    f => f.projectCustomField?.bundle
  );
  const priorityField = bundleFields.find(
    f => (f.projectCustomField.field?.name || '').toLowerCase() === 'priority'
  );

  const target = priorityField ?? issue.fields?.find(
    f => toArray(f.value).some(isColoredValue)
  );

  if (!target) return null;

  const coloredValue = toArray(target.value).find(isColoredValue);
  if (!coloredValue?.color) return null;

  const fieldName = getName(target.projectCustomField.field || {} as IssueFieldValue);
  return {
    style: {background: coloredValue.color.background, color: coloredValue.color.foreground},
    letter: (getName(coloredValue) || 'C')[0].toUpperCase(),
    title: `${fieldName}: ${getName(coloredValue)}`
  };
}

function getFieldValuePresentation(field: IssueField): string {
  const valueType = field.projectCustomField?.field?.fieldType?.valueType || '';

  return toArray(field.value).map(v => {
    if (valueType.indexOf('date') > -1) {
      const ts = (v as unknown as number);
      if (typeof ts === 'number' && ts > 0) {
        const withTime = valueType.indexOf('time') > -1;
        return formatTimestamp(ts, withTime);
      }
    }
    return getName(v) || v.presentation || (v.minutes ? `${v.minutes}m` : '') || v.login || '';
  }).filter(Boolean).join(', ');
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

function getVisibleFieldValue(issue: Issue, fieldConfig: FieldColumnConfig): string | null {
  if (fieldConfig.builtin) {
    const ts = fieldConfig.key === 'created' ? issue.created : issue.updated;
    if (ts && ts > 0) {
      return formatTimestamp(ts, true);
    }
    return null;
  }

  const issueField = (issue.fields || []).find(
    f => f.projectCustomField?.field?.name === fieldConfig.key
  );
  if (!issueField) return null;

  const values = toArray(issueField.value);
  if (values.length === 0) return null;

  return getFieldValuePresentation(issueField);
}

function getVisibleFieldColor(issue: Issue, fieldConfig: FieldColumnConfig) {
  if (fieldConfig.builtin) return null;

  const issueField = (issue.fields || []).find(
    f => f.projectCustomField?.field?.name === fieldConfig.key
  );
  if (!issueField) return null;

  const firstValue = toArray(issueField.value)[0];
  if (firstValue && isColoredValue(firstValue) && firstValue.color) {
    return {
      background: firstValue.color.background,
      color: firstValue.color.foreground,
    };
  }
  return null;
}

const IssueLineComponent: React.FC<Props> = ({issue, baseUrl, visibleFields}) => {
  const coloredSquare = getColoredSquare(issue);
  const isResolved = issue.resolved != null;
  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const issueUrl = `${normalizedUrl}issue/${issue.idReadable}`;

  const hasVisibleFields = visibleFields && visibleFields.length > 0;

  return (
    <div className="il-issue">
      <div className="il-main-row">
        {coloredSquare && (
          <span
            className="il-colored-square"
            style={coloredSquare.style}
            title={coloredSquare.title}
          >
            {coloredSquare.letter}
          </span>
        )}

        <a
          className={`il-issue-id ${isResolved ? 'il-issue-id--resolved' : ''}`}
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {issue.idReadable}
        </a>

        <a
          className={`il-issue-summary ${isResolved ? 'il-issue-summary--resolved' : ''}`}
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {issue.summary}
        </a>

        {hasVisibleFields && visibleFields!.map(fc => {
          const val = getVisibleFieldValue(issue, fc);
          if (!val) return null;
          const colorInfo = getVisibleFieldColor(issue, fc);
          return (
            <span key={fc.key} className="il-tag" title={fc.label}>
              {colorInfo ? (
                <span
                  className="il-tag-color"
                  style={{background: colorInfo.background, color: colorInfo.color}}
                >
                  {val}
                </span>
              ) : (
                <>
                  <span className="il-tag-label">{fc.label}:</span>
                  <span className="il-tag-value">{val}</span>
                </>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export const IssueLine = memo(IssueLineComponent);
