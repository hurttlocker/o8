export type PiCacheWarming = 'off' | 'streaming' | 'idle';

export function isPiCacheWarming(value: unknown): value is PiCacheWarming {
  return value === 'off' || value === 'streaming' || value === 'idle';
}

export function supportsPiCacheWarming(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[+-])/);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 86));
}
