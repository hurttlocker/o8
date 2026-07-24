import { relativeTimeLabel } from '@/lib/format/relative-time';

export function formatMobileActivityTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value.trim() || 'recently';
  return relativeTimeLabel(timestamp, { subMinute: 'just-now-lower' });
}
