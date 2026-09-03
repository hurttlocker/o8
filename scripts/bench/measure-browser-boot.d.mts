export interface BrowserPerformanceEntry {
  name: string;
  fetchStart: number;
  requestStart: number;
}

export function summarizeBrowserPerformanceEntries(entries: BrowserPerformanceEntry[]): {
  bootApiRequestCount: number;
  maxClientQueueStallMs: number | null;
};

export interface BenchmarkTargetIdentity {
  appVersion: string | null;
  buildGitSha: string | null;
  buildMode: 'packaged' | 'production' | 'development' | null;
  platform: string | null;
  unavailableReason: string | null;
}

export function targetFromPanelStatus(payload: unknown): BenchmarkTargetIdentity;
