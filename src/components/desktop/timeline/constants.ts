import type { SegmentKind } from './types';

export const SEGMENT_COLORS: Record<SegmentKind, string> = {
  coding: '#2563eb',
  thinking: '#93c5fd',
  testing: '#f59e0b',
  error: '#ef4444',
  idle: '#e5e7eb',
};

export const SEGMENT_LABELS: Record<SegmentKind, string> = {
  thinking: 'THINKING',
  coding: 'CODING',
  testing: 'TESTING',
  error: 'ERRORS',
  idle: 'IDLE',
};

export const DEFAULT_TIMELINE_REPO = 'hurttlocker/cortex-ide';
export const TIMELINE_BAR_HEIGHT = 20;
export const TIMELINE_ACTIVE_SEGMENT_MIN_PX = 20;
export const TIMELINE_THINKING_MIN_PX = 20;
export const TIMELINE_TESTING_MIN_PX = 20;

// Keep the drill-down implementation in place, but disable dashboard
// double-click entry until the interaction is ready to ship.
export const TIMELINE_DRILLDOWN_ENABLED = false;

export const DRILL_LEFT_GUTTER = 72;
export const DRILL_TOP_GUTTER = 82;
export const DRILL_MIN_WIDTH = 340;
export const DRILL_MAX_WIDTH = 720;
export const DRILL_MIN_HEIGHT = 320;
export const DRILL_MAX_HEIGHT = 680;
