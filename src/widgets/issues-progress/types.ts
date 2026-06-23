// Lead time thresholds per issue type (days)
export interface LtThreshold {
  lt50?: number;  // LT 50% in days
  lt80?: number;  // LT 80% in days
}

// Map of issue type name → LT thresholds
export type LtSettings = Record<string, LtThreshold>;

// Status with display order
export interface StatusOrderItem {
  id: string;
  name: string;
  color?: string;
}

// In-memory widget config (rich objects)
export interface WidgetConfig {
  search: string;
  title?: string;
  projects: string[];           // array of project IDs
  statusOrder: StatusOrderItem[]; // ordered list of statuses to display
  ltEnabled: boolean;
  ltSettings: LtSettings;       // per-type LT thresholds
  showEstimateDate: boolean;
  refreshInterval: number;      // minutes; 0 = no auto-refresh
}

// Stored widget config (flat primitives for host.storeConfig)
export interface StoredWidgetConfig {
  search: string;
  title?: string;
  projects?: string;            // JSON-encoded string[]
  statusOrder?: string;         // JSON-encoded StatusOrderItem[]
  ltEnabled?: string;           // 'true' | 'false'
  ltSettings?: string;          // JSON-encoded LtSettings
  showEstimateDate?: string;    // 'true' | 'false'
  refreshInterval?: number;
}

export function parseStoredConfig(stored: Record<string, string>): WidgetConfig {
  return {
    search: stored.search ?? '',
    title: stored.title,
    projects: stored.projects ? JSON.parse(stored.projects) : [],
    statusOrder: stored.statusOrder ? JSON.parse(stored.statusOrder) : [],
    ltEnabled: stored.ltEnabled === 'true',
    ltSettings: stored.ltSettings ? JSON.parse(stored.ltSettings) : {},
    showEstimateDate: stored.showEstimateDate === 'true',
    refreshInterval: stored.refreshInterval ? Number(stored.refreshInterval) : 0,
  };
}

export function serializeConfig(config: WidgetConfig): StoredWidgetConfig {
  return {
    search: config.search,
    title: config.title,
    projects: JSON.stringify(config.projects),
    statusOrder: JSON.stringify(config.statusOrder),
    ltEnabled: String(config.ltEnabled),
    ltSettings: JSON.stringify(config.ltSettings),
    showEstimateDate: String(config.showEstimateDate),
    refreshInterval: config.refreshInterval,
  };
}