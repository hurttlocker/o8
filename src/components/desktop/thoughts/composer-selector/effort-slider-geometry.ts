import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export const EFFORT_SLIDER_ORDER: readonly ThinkingEffort[] = [
  'low',
  'medium',
  'adaptive',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function orderedEffortSliderStops(
  supported: readonly ThinkingEffort[],
  locked: readonly ThinkingEffort[],
): ThinkingEffort[] {
  const available = new Set([...supported, ...locked]);
  return EFFORT_SLIDER_ORDER.filter((effort) => available.has(effort));
}

export function effortSliderProgress(index: number, count: number): number {
  if (count < 2) return 0;
  return Math.max(0, Math.min(1, index / (count - 1)));
}

export function effortSliderStopAtPointer(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  stops: readonly ThinkingEffort[],
): ThinkingEffort | undefined {
  if (stops.length === 0) return undefined;
  const usableWidth = Math.max(1, trackWidth - 22);
  const progress = Math.max(0, Math.min(1, (clientX - trackLeft - 11) / usableWidth));
  return stops[Math.round(progress * (stops.length - 1))];
}
