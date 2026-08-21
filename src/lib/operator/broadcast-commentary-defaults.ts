export type BroadcastCommentaryMode = 'off' | 'interval';

export interface BroadcastCommentaryDefaults {
  broadcastCommentary: BroadcastCommentaryMode;
  broadcastCommentaryIntervalMinutes: number;
  broadcastCommentaryMinNewEvents: number;
  broadcastCommentaryMaxPerHour: number;
}

export const BROADCAST_COMMENTARY_FALLBACK: BroadcastCommentaryDefaults = {
  broadcastCommentary: 'off',
  broadcastCommentaryIntervalMinutes: 4,
  broadcastCommentaryMinNewEvents: 3,
  broadcastCommentaryMaxPerHour: 12,
};

export function isBroadcastCommentaryMode(value: unknown): value is BroadcastCommentaryMode {
  return value === 'off' || value === 'interval';
}

export function resolveStoredBroadcastCommentary(
  stored: Partial<BroadcastCommentaryDefaults>,
): Partial<BroadcastCommentaryDefaults> {
  const result: Partial<BroadcastCommentaryDefaults> = {};
  if (isBroadcastCommentaryMode(stored.broadcastCommentary)) {
    result.broadcastCommentary = stored.broadcastCommentary;
  }
  for (const [field, maximum] of [
    ['broadcastCommentaryIntervalMinutes', 1_440],
    ['broadcastCommentaryMinNewEvents', 100],
    ['broadcastCommentaryMaxPerHour', 60],
  ] as const) {
    const value = stored[field];
    if (Number.isSafeInteger(value) && Number(value) >= 1) {
      result[field] = Math.min(maximum, Number(value));
    }
  }
  return result;
}

export function resolveBroadcastCommentaryDefaults(
  stored: Partial<BroadcastCommentaryDefaults>,
): BroadcastCommentaryDefaults {
  return {
    ...BROADCAST_COMMENTARY_FALLBACK,
    ...resolveStoredBroadcastCommentary(stored),
  };
}

export function broadcastCommentarySettingSources(
  stored: Partial<BroadcastCommentaryDefaults>,
): Record<keyof BroadcastCommentaryDefaults, 'file' | 'default'> {
  return {
    broadcastCommentary: stored.broadcastCommentary !== undefined ? 'file' : 'default',
    broadcastCommentaryIntervalMinutes: stored.broadcastCommentaryIntervalMinutes !== undefined ? 'file' : 'default',
    broadcastCommentaryMinNewEvents: stored.broadcastCommentaryMinNewEvents !== undefined ? 'file' : 'default',
    broadcastCommentaryMaxPerHour: stored.broadcastCommentaryMaxPerHour !== undefined ? 'file' : 'default',
  };
}

export function applyBroadcastCommentaryUpdate(
  stored: Partial<BroadcastCommentaryDefaults>,
  update: Partial<BroadcastCommentaryDefaults>,
): void {
  if (update.broadcastCommentary !== undefined) {
    if (!isBroadcastCommentaryMode(update.broadcastCommentary)) {
      throw new Error('broadcastCommentary must be "off" or "interval".');
    }
    stored.broadcastCommentary = update.broadcastCommentary;
  }
  for (const [field, maximum] of [
    ['broadcastCommentaryIntervalMinutes', 1_440],
    ['broadcastCommentaryMinNewEvents', 100],
    ['broadcastCommentaryMaxPerHour', 60],
  ] as const) {
    const value = update[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${field} must be an integer from 1 through ${maximum}.`);
    }
    stored[field] = value;
  }
}
