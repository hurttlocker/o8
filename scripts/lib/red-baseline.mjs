import { existsSync, readFileSync } from 'node:fs';

/**
 * Reads the exempted red-file baseline for the integration gate (#2391).
 * Returns a Set of manifest paths, or null when the file is absent or
 * unreadable, which keeps the gate strict.
 */
export function loadRedBaseline(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.files)) return null;
    return new Set(parsed.files.map((entry) => entry?.path).filter((entry) => typeof entry === 'string'));
  } catch {
    return null;
  }
}

/**
 * Splits per-file gate results against the baseline. A result is
 * `{ file, failed: boolean }`. Without a baseline every failure is new red.
 */
export function classifyAgainstBaseline(results, baseline) {
  const green = [];
  const baselineRed = [];
  const newRed = [];
  const nowGreen = [];
  for (const result of results) {
    const listed = baseline?.has(result.file) ?? false;
    if (result.failed) (listed ? baselineRed : newRed).push(result.file);
    else {
      green.push(result.file);
      if (listed) nowGreen.push(result.file);
    }
  }
  return { ran: results.length, green, baselineRed, newRed, nowGreen };
}
