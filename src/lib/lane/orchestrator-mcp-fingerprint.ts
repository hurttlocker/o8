import { createHash } from 'node:crypto';

export interface McpConfigFingerprint {
  hash: string;
  material: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/** Stable semantic material: object insertion order never recycles a warm proc. */
export function buildMcpConfigHashMaterial(config: unknown): string {
  return JSON.stringify(canonicalize(config));
}

export function fingerprintMcpConfig(config: unknown): McpConfigFingerprint {
  const material = buildMcpConfigHashMaterial(config);
  return {
    hash: createHash('sha256').update(material).digest('hex').slice(0, 16),
    material,
  };
}

function firstDivergence(previous: unknown, next: unknown, path: string): string | null {
  if (Object.is(previous, next)) return null;

  if (Array.isArray(previous) && Array.isArray(next)) {
    const length = Math.max(previous.length, next.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= previous.length || index >= next.length) return `${path}[${index}]`;
      const divergence = firstDivergence(previous[index], next[index], `${path}[${index}]`);
      if (divergence) return divergence;
    }
    return null;
  }

  if (previous && next && typeof previous === 'object' && typeof next === 'object') {
    const previousObject = previous as Record<string, unknown>;
    const nextObject = next as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(previousObject), ...Object.keys(nextObject)])].sort();
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in previousObject) || !(key in nextObject)) return childPath;
      const divergence = firstDivergence(previousObject[key], nextObject[key], childPath);
      if (divergence) return divergence;
    }
    return null;
  }

  return path || 'mcpConfig';
}

/** Returns a key path only; secret values never enter recycle logs. */
export function firstMcpConfigDivergence(previousMaterial: string, nextMaterial: string): string {
  try {
    const previous = JSON.parse(previousMaterial) as unknown;
    const next = JSON.parse(nextMaterial) as unknown;
    return firstDivergence(previous, next, '') ?? 'mcpConfig';
  } catch {
    return 'mcpConfig';
  }
}
