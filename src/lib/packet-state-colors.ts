/**
 * packet-state-colors — single source of truth for state→color mapping
 * across BOTH the workspace top tabs and the left-rail chat/archive rows.
 *
 * Tabs and rows render the same state differently:
 *   - tabs use a tinted background + tinted border (8% / 22% opacity)
 *   - rows use a transparent background with an accent strip/dot
 *
 * The base palette is shared so an `awaiting_review` packet reads as the
 * same orange on both surfaces. Don't fork these values — extend this
 * module if a new state appears.
 */

export type PacketStateKey =
  | 'neutral'
  | 'running'
  | 'review'
  | 'merged'
  | 'failed';

export interface PacketStateColorScheme {
  key: PacketStateKey;
  /** Base hex color for the state. */
  base: string;
  /** Tinted background for top tabs (8% opacity). */
  tabBg: string;
  /** Tinted border for top tabs (22-28% opacity). */
  tabBorder: string;
  /** Text color when this state is applied to a tab. */
  tabText: string;
  /** Accent color for row strips/dots. */
  rowAccent: string;
  /** Icon color when the state warrants a colored glyph. */
  iconColor: string;
  /** Human-readable label (used by tooltips / chips). */
  label: string | null;
}

const SCHEMES: Record<PacketStateKey, PacketStateColorScheme> = {
  neutral: {
    key: 'neutral',
    base: 'transparent',
    tabBg: 'transparent',
    tabBorder: 'var(--t-divider-subtle)',
    tabText: 'var(--t-text-secondary)',
    rowAccent: 'transparent',
    iconColor: 'var(--t-text-muted)',
    label: null,
  },
  running: {
    key: 'running',
    base: 'var(--t-accent)',
    tabBg: 'rgba(37, 99, 235, 0.08)',
    tabBorder: 'rgba(37, 99, 235, 0.22)',
    tabText: 'var(--t-accent)',
    rowAccent: 'var(--t-accent)',
    iconColor: 'var(--t-accent)',
    label: 'Running',
  },
  review: {
    key: 'review',
    base: '#FF5A1F',
    tabBg: 'rgba(255, 90, 31, 0.08)',
    tabBorder: 'rgba(255, 90, 31, 0.22)',
    tabText: '#FF5A1F',
    rowAccent: '#FF5A1F',
    iconColor: '#FF5A1F',
    label: 'Review',
  },
  merged: {
    key: 'merged',
    base: '#16a34a',
    tabBg: 'rgba(22, 163, 74, 0.08)',
    tabBorder: 'rgba(22, 163, 74, 0.28)',
    tabText: '#15803d',
    rowAccent: '#16a34a',
    iconColor: '#15803d',
    label: 'Merged',
  },
  failed: {
    key: 'failed',
    base: '#ef4444',
    tabBg: 'rgba(239, 68, 68, 0.08)',
    tabBorder: 'rgba(239, 68, 68, 0.26)',
    tabText: '#dc2626',
    rowAccent: '#ef4444',
    iconColor: '#dc2626',
    label: 'Blocked',
  },
};

/** Get the color scheme for a packet state. Always returns a value
 *  (defaults to `neutral` for unknown / null inputs). */
export function packetStateColorScheme(key: PacketStateKey | null | undefined): PacketStateColorScheme {
  if (!key) return SCHEMES.neutral;
  return SCHEMES[key] ?? SCHEMES.neutral;
}

/** Translate a lane.status string (lanes table) into a PacketStateKey.
 *  Used by archived-lane rows that don't have the full packet object. */
export function laneStatusToStateKey(status: string | null | undefined): PacketStateKey {
  if (!status) return 'neutral';
  switch (status) {
    case 'completed':
    case 'merging':
      return 'merged';
    case 'failed':
      return 'failed';
    case 'reviewing':
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
      return 'review';
    case 'running':
    case 'launching':
    case 'recovering':
      return 'running';
    default:
      return 'neutral';
  }
}
