import React, {memo, useState} from 'react';
import type {Issue, IssueField, IssueFieldValue} from './types';
import './issue-line.css';

interface Props {
  issue: Issue;
  baseUrl: string;
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
  return toArray(field.value).map(v =>
    getName(v) || v.presentation || (v.minutes ? `${v.minutes}m` : '') || v.login || ''
  ).filter(Boolean).join(', ');
}

const IssueLineComponent: React.FC<Props> = ({issue, baseUrl}) => {
  const [expanded, setExpanded] = useState(false);
  const coloredSquare = getColoredSquare(issue);
  const valuableFields = getValuableFields(issue);
  const isResolved = issue.resolved != null;
  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const issueUrl = `${normalizedUrl}issue/${issue.idReadable}`;

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
