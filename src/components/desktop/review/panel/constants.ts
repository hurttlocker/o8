import type { CSSProperties } from 'react';
import type { ReviewScope } from './types';

const SCOPE_LABELS: Record<ReviewScope, string> = { all: 'All changes', 'last-turn': 'Last turn', staged: 'Staged', unstaged: 'Unstaged' };
const SCOPE_ORDER: ReviewScope[] = ['all', 'last-turn', 'staged', 'unstaged'];
// Above this many visible rows, files default to collapsed so the panel
// doesn't fire N concurrent /api/panel/file-diff requests on mount (#1084).
const BIG_CHANGESET = 25;

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";
const REVIEW_CONTROL_BG = 'var(--t-input-bg, #ffffff)';
const REVIEW_CONTROL_BG_ACTIVE = 'var(--t-chrome-btn-active-bg, var(--t-input-bg, #ffffff))';
const REVIEW_POPOVER_BG = 'var(--t-chat-surface-bg, #faf9f4)';
const REVIEW_POPOVER_SHADOW = '0 16px 40px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.06)';
const REVIEW_DRAWER_WIDTH = 320;

const NUM_CELL: CSSProperties = {
  display: 'inline-block',
  width: 32,
  color: 'var(--t-text-faint)',
  textAlign: 'right',
  flexShrink: 0,
  fontVariantNumeric: 'tabular-nums',
  userSelect: 'none',
};

export {
  SCOPE_LABELS,
  SCOPE_ORDER,
  BIG_CHANGESET,
  UI_FONT,
  MONO_FONT,
  REVIEW_CONTROL_BG,
  REVIEW_CONTROL_BG_ACTIVE,
  REVIEW_POPOVER_BG,
  REVIEW_POPOVER_SHADOW,
  REVIEW_DRAWER_WIDTH,
  NUM_CELL,
};
