import type React from 'react';

export const THEME_ACCENT = 'var(--t-accent, #2563eb)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
export const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
export const EMPTY_STATE_SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const;

export const CHANGED_FILE_STYLE = {
  fontSize: 11,
  color: 'var(--t-text-secondary)',
  fontFamily: '"SF Mono", ui-monospace, monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as React.CSSProperties;

export const OPERATOR_DETAIL_STYLE = {
  fontSize: 11,
  color: 'var(--t-text-muted)',
  lineHeight: 1.45,
} as React.CSSProperties;

export const TABLE_HEADER_CELL_STYLE = {
  textAlign: 'left' as const,
  padding: '10px 14px',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: 'var(--t-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '2px solid var(--t-divider)',
  whiteSpace: 'nowrap',
} as React.CSSProperties;

export const TABLE_BODY_CELL_STYLE = {
  textAlign: 'left' as const,
  padding: '10px 14px',
  fontSize: '0.85rem',
  color: 'var(--t-text)',
  borderBottom: '1px solid var(--t-divider-subtle)',
} as React.CSSProperties;

export const SOURCE_LINK_STYLE = {
  display: 'block',
  padding: '8px 10px',
  borderRadius: 10,
  background: 'rgba(248,250,252,0.92)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  color: '#2563eb',
  textDecoration: 'none',
  fontSize: 11,
  lineHeight: 1.4,
  wordBreak: 'break-word',
} as React.CSSProperties;

export const SOURCE_CARD_SUMMARY_STYLE = {
  fontSize: 11,
  color: 'var(--t-text-secondary)',
  fontWeight: 600,
  lineHeight: 1.35,
} as React.CSSProperties;

export const O_PLACEHOLDERS = [
  'Orchestrate something...',
  'Operate on this repo...',
  'Outline the next step...',
  'Optimize this workflow...',
  'Observe the agent output...',
  'Order a new task...',
  'Organize the worktree...',
  'Orient the mission...',
];

export const INTERNAL_PROTOCOL_TAGS = [
  /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/gi,
  /<<<END_UNTRUSTED_CHILD_RESULT>>>/gi,
  /<\/?[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+[^>]*>/gi,
  /<\/?(?:command-name|local-command-(?:stdout|stderr|input|result)|task-notification|task-completion-event|runtime-context|begin-untrusted-child-result|end-untrusted-child-result|untrusted-child-result|task-event|command-output|command-result|status|summary|task|source|action)[^>]*>/gi,
];

export const OPERATOR_COLLAPSE_MARKERS = [
  /analyze the user'?s input/i,
  /analyze tool results/i,
  /determine the best response strategy/i,
  /formulate the response/i,
  /draft the response/i,
  /drafting the response/i,
  /drafting the content/i,
  /execution plan/i,
  /self-correction/i,
  /operator summary/i,
  /thought for \d/i,
  /gemini 3\.1 pro/i,
  /click to play from here/i,
];

export const SIDEBAR_KEYFRAME_STYLES = `
  @keyframes sidebarActiveTurnIn {
    from { opacity: 0; transform: translateY(8px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes sidebarApprovalIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes sidebarSourceCardIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes sidebarSourceExpand {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes reviewingBreathe {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.25); opacity: 0.7; }
  }
  @keyframes reviewingRing {
    0% { transform: scale(1); opacity: 0.6; }
    100% { transform: scale(2.8); opacity: 0; }
  }
`;
