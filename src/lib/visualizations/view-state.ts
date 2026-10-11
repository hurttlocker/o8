/** Small, presentation-only snapshots. They never start a turn or reach a provider. */
export const VISUALIZATION_STATE_BYTES = 16 * 1024;

export function visualizationState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let nodes = 0;
  function valid(item: unknown, depth: number): boolean {
    if (++nodes > 1200 || depth > 12) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 8192;
    if (Array.isArray(item)) return item.length <= 500 && item.every(child => valid(child, depth + 1));
    if (typeof item !== 'object') return false;
    const entries = Object.entries(item);
    return entries.length <= 100 && entries.every(([key, child]) => key.length <= 120
      && !['__proto__', 'constructor', 'prototype'].includes(key) && valid(child, depth + 1));
  }
  if (!valid(value, 0)) return null;
  try {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json).length <= VISUALIZATION_STATE_BYTES ? JSON.parse(json) as Record<string, unknown> : null;
  } catch { return null; }
}
