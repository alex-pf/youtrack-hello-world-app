export interface FieldColumnConfig {
  key: string;       // field name (e.g. 'Priority') or built-in key ('created', 'updated')
  label: string;     // display label
  builtin?: boolean; // true for created/updated/resolved
}

export interface WidgetConfig {
  search: string;
  title?: string;
  visibleFields?: FieldColumnConfig[];
}

export interface IssueFieldValue {
  id?: string;
  name?: string;
  localizedName?: string;
  login?: string;
  avatarUrl?: string;
  presentation?: string;
  minutes?: number;
  color?: {
    id: number;
    foreground: string;
    background: string;
  };
}

export interface ProjectCustomField {
  id: string;
  bundle?: { id: string };
  field: {
    id: string;
    name: string;
    localizedName?: string;
    fieldType?: {
      id: string;
      valueType: string;
    };
  };
}

export interface IssueField {
  id: string;
  value: IssueFieldValue | IssueFieldValue[] | null;
  projectCustomField: ProjectCustomField;
}

export interface Issue {
  id: string;
  idReadable: string;
  summary: string;
  resolved: number | null;
  created: number | null;
  updated: number | null;
  fields: IssueField[];
}
