export interface BrowserPerformanceEntry {
  name: string;
  fetchStart: number;
  requestStart: number;
}

export function summarizeBrowserPerformanceEntries(entries: BrowserPerformanceEntry[]): {
  bootApiRequestCount: number;
  maxClientQueueStallMs: number | null;
};
