import { stripVTControlCharacters } from 'node:util';

import { isNativeWorkerToken } from './worker-token';

/** Raw setup output is secret-bearing. Callers must never forward it to a log. */
export function extractSetupWorkerToken(raw: string, successfulExit = false): string | null {
  if (!successfulExit) return null;
  const text = stripVTControlCharacters(raw);
  const matches = [...new Set(text.match(/sk-ant-oat01-[A-Za-z0-9_-]+/g) ?? [])];
  return matches.length === 1 && isNativeWorkerToken(matches[0]) ? matches[0] : null;
}

export function workerTokenSetupNeedsBrowser(raw: string): boolean {
  return stripVTControlCharacters(raw).includes('Browser didn\'t open?');
}
