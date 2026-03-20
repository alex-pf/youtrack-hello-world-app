import type AlertService from '@jetbrains/ring-ui-built/components/alert-service/alert-service';
import type {RequestParams} from '@jetbrains/ring-ui-built/components/http/http';

export interface HubService {
  id: string;
  applicationName: string;
  homeUrl: string;
}

interface BaseAPILayer {
  alert: (...args: Parameters<(typeof AlertService)['addAlert']>) => void;
  enterModalMode: Promise<() => void>;
  exitModalMode: Promise<() => void>;
  closeWidget: () => void;
}

export interface InstanceAwareAPILayer extends BaseAPILayer {
  fetchYouTrack: <T = unknown>(relativeURL: string, requestParams?: RequestParams) => Promise<T>;
}

export interface PluginEndpointAPILayer extends InstanceAwareAPILayer {
  fetchApp: <T = unknown>(relativeURL: string, requestParams?: RequestParams & {scope?: boolean}) => Promise<T>;
}

export interface EmbeddableWidgetAPI extends PluginEndpointAPILayer {
  setTitle: (label: string, labelUrl: string) => Promise<void>;
  setLoadingAnimationEnabled: (isEnabled: boolean) => Promise<void>;
  enterConfigMode: () => Promise<void>;
  exitConfigMode: () => Promise<void>;
  setError: (e: Error) => Promise<void>;
  clearError: () => Promise<void>;
  readCache: <T = unknown>() => Promise<T | null>;
  storeCache: (data: unknown) => Promise<void>;
  readConfig: <T = unknown>() => Promise<T | null>;
  storeConfig: (config: unknown) => Promise<void>;
  fetchHub: (relativeURL: string, requestParams?: RequestParams) => Promise<unknown>;
  loadServices: (applicationName: string) => Promise<HubService[]>;
  removeWidget: () => void;
}

export type HostAPI = PluginEndpointAPILayer;

type AppAPI = {
  onRefresh?: () => void;
  onConfigure?: () => void;
}

type YTAppInterface = {
  locale: string;
  entity?: {
    id: string;
    type: 'user' | 'article' | 'ticket' | 'project' | 'app'
  };
  register: (appApi?: AppAPI) => Promise<HostAPI | EmbeddableWidgetAPI>;
}

declare global {
  const YTApp: YTAppInterface;
}
