export type BrowserProviderId =
  | 'openclaw'
  | 'playwright'
  | 'cdp'
  | 'webkit'
  | (string & {});

export type BrowserSurfaceOwnership = 'provider' | 'discovered' | 'owned';
export type BrowserSurfaceStatus = 'active' | 'idle' | 'unavailable';

export interface BrowserSurfaceCapabilities {
  attach: boolean;
  liveViewport: boolean;
  inspectDom: boolean;
  selectElement: boolean;
  controlledNavigation: boolean;
  screenshots: boolean;
  persistentProfile: boolean;
}

export interface BrowserSurfaceSummary {
  id: string;
  provider: BrowserProviderId;
  ownership: BrowserSurfaceOwnership;
  status: BrowserSurfaceStatus;
  sourceLabel: string;
  browserName?: string;
  sessionKey?: string;
  browserSessionId?: string;
  profileId?: string;
  pageId?: string;
  url?: string;
  title?: string;
  attachUrl?: string;
  lastAction?: string;
  lastActionAt?: number;
  capabilities: BrowserSurfaceCapabilities;
}

export interface BrowserAttachmentPage {
  id: string;
  title?: string;
  url?: string;
  type?: string;
  attachUrl?: string;
  status?: BrowserSurfaceStatus;
}

export interface BrowserAttachmentSummary {
  attachedAt: string;
  provider: BrowserProviderId;
  surface: BrowserSurfaceSummary;
  browserName?: string;
  browserVersion?: string;
  note?: string;
  pages: BrowserAttachmentPage[];
}

export interface BrowserInventorySnapshot {
  generatedAt: string;
  sourceLabel: string;
  surfaces: BrowserSurfaceSummary[];
  error?: string;
}
