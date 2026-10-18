export const BROWSER_OPEN_REQUEST_EVENT = 'o8:browser-open-request';

export interface BrowserOpenRequest {
  requestId: string;
  url: string | null;
  createdAt: number;
  accepted: boolean;
  scopeKey?: string;
  error?: string;
}

declare global {
  interface Window {
    __o8BrowserOpenRequests?: Map<string, BrowserOpenRequest>;
  }
}
