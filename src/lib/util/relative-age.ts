type Timestamp = Date | string | number | null | undefined;

export function timestampMillis(timestamp: Timestamp): number | null {
  if (timestamp == null || timestamp === '') return null;
  const parsed = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function relativeAge(timestamp: Timestamp, now = Date.now()): string {
  const parsed = timestampMillis(timestamp);
  if (parsed === null || !Number.isFinite(now)) return 'unknown';
  const ageMs = Math.max(0, now - parsed);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < 1_000) return 'just now';
  if (ageMs < minute) return `${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}
