import type { Browser } from 'playwright-core';

export interface MeasuredBrowser {
  browser: Browser;
  browserPid: number | null;
  inventory: unknown;
  timer: NodeJS.Timeout;
}

export function launchMeasuredBrowser(browserPath: string, runTag: string): Promise<MeasuredBrowser>;
export function closeMeasuredBrowser(state: MeasuredBrowser): Promise<{ survivors: unknown[] }>;
