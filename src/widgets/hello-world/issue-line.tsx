import React, {memo, useState} from 'react';
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

function getValuableFields(issue: Issue): IssueField[] {
  return (issue.fields || []).filter(f => {
    const values = toArray(f.value);
    if (values.length === 0) return false;
    const valueType = f.projectCustomField?.field?.fieldType?.valueType;
    return valueType !== 'text';
  });
}

function getFieldValuePresentation(field: IssueField): string {
  const valueType = field.projectCustomField?.field?.fieldType?.valueType || '';

  return toArray(field.value).map(v => {
    // Handle date and datetime types
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

/**
 * Get the presentation value for a visible field config from an issue.
 */
function getVisibleFieldValue(issue: Issue, fieldConfig: FieldColumnConfig): string | null {
  if (fieldConfig.builtin) {
    const ts = fieldConfig.key === 'created' ? issue.created : issue.updated;
    if (ts && ts > 0) {
      return formatTimestamp(ts, true);
    }
    return null;
  }

  // Custom field — find by field name
  const issueField = (issue.fields || []).find(
    f => f.projectCustomField?.field?.name === fieldConfig.key
  );
  if (!issueField) return null;

  const values = toArray(issueField.value);
  if (values.length === 0) return null;

  return getFieldValuePresentation(issueField);
}

/**
 * Get color info for a visible custom field.
 */
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
      letter: (getName(firstValue) || 'C')[0].toUpperCase(),
    };
  }
  return null;
}

const IssueLineComponent: React.FC<Props> = ({issue, baseUrl, visibleFields}) => {
  const [expanded, setExpanded] = useState(false);
  const coloredSquare = getColoredSquare(issue);
  const valuableFields = getValuableFields(issue);
  const isResolved = issue.resolved != null;
  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const issueUrl = `${normalizedUrl}issue/${issue.idReadable}`;

  const hasVisibleFields = visibleFields && visibleFields.length > 0;

  return (
    <div
      className={`il-issue ${expanded ? 'il-issue--expanded' : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      {coloredSquare && (
        <span
          className="il-colored-square"
          style={coloredSquare.style}
          title={coloredSquare.title}
        >
          {coloredSquare.letter}
        </span>
      )}

      <div className="il-issue-info" onClick={e => e.stopPropagation()}>
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
      </div>

      <div className="il-toggler">
        {expanded ? '▲' : '▼'}
      </div>

      {/* Visible fields — shown inline under the issue summary */}
      {hasVisibleFields && (
        <div className="il-visible-fields">
          {visibleFields!.map(fc => {
            const val = getVisibleFieldValue(issue, fc);
            if (!val) return null;
            const colorInfo = getVisibleFieldColor(issue, fc);
            return (
              <span key={fc.key} className="il-visible-field" title={fc.label}>
                <span className="il-visible-field-label">{fc.label}:</span>
                {colorInfo && (
                  <span
                    className="il-field-color"
                    style={{background: colorInfo.background, color: colorInfo.color}}
                  >
                    {colorInfo.letter}
                  </span>
                )}
                <span className="il-visible-field-value">{val}</span>
              </span>
            );
          })}
        </div>
      )}

      {expanded && valuableFields.length > 0 && (
        <div className="il-fields">
          {valuableFields.map(field => (
            <div key={field.id} className="il-field-row">
              <span className="il-field-name">
                {field.projectCustomField.field?.localizedName || field.projectCustomField.field?.name}
              </span>
              <span className="il-field-value">
                {getFieldValuePresentation(field)}
                {(() => {
                  const firstValue = toArray(field.value)[0];
                  if (firstValue && isColoredValue(firstValue) && firstValue.color) {
                    return (
                      <span
                        className="il-field-color"
                        style={{background: firstValue.color.background, color: firstValue.color.foreground}}
                      >
                        {(getName(firstValue) || 'C')[0].toUpperCase()}
                      </span>
                    );
                  }
                  return null;
                })()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const IssueLine = memo(IssueLineComponent);
