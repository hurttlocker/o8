'use client';

import { HistoryIcon } from '@/components/desktop/thoughts/ThoughtsIcons';

export function ThreadsDropdown({
  historyOpen,
  onToggleHistory,
}: {
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggleHistory}
      aria-pressed={historyOpen}
      aria-label="History"
      title="History"
      style={{
        width: 34,
        height: 26,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: historyOpen ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: historyOpen ? 'var(--t-accent-soft)' : 'transparent',
        color: historyOpen ? 'var(--t-accent)' : 'var(--t-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <HistoryIcon />
    </button>
  );
}
