'use client';

interface ThreadExportButtonProps {
  state: 'idle' | 'copying' | 'copied' | 'error';
  onClick: () => void;
}

function CopyMarkdownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function ThreadExportButton({ state, onClick }: ThreadExportButtonProps) {
  const label = state === 'copied'
    ? 'Copied'
    : state === 'error'
      ? 'Retry copy'
      : state === 'copying'
        ? 'Copying...'
        : 'Copy as Markdown';

  const title = state === 'error'
    ? 'Retry copying the active thread as Markdown'
    : 'Copy the active thread as Markdown';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'copying'}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 170,
        minHeight: 44,
        paddingTop: 0,
        paddingRight: 14,
        paddingBottom: 0,
        paddingLeft: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: state === 'copied'
          ? 'var(--t-accent-border)'
          : state === 'error'
            ? 'var(--t-danger, #ef4444)'
            : 'var(--t-panel-border)',
        borderRadius: 12,
        backgroundColor: state === 'copied'
          ? 'var(--t-accent-soft)'
          : state === 'error'
            ? 'var(--t-bg-card)'
            : 'var(--t-panel)',
        color: state === 'copied'
          ? 'var(--t-accent)'
          : state === 'error'
            ? 'var(--t-danger, #ef4444)'
            : 'var(--t-text-secondary)',
        cursor: state === 'copying' ? 'default' : 'pointer',
        fontSize: 11.5,
        fontWeight: 700,
        letterSpacing: '-0.01em',
        transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
        boxShadow: state === 'copied' ? 'var(--t-glass-shadow)' : 'none',
      }}
      onMouseEnter={(event) => {
        if (state === 'copying' || state === 'copied') return;
        event.currentTarget.style.backgroundColor = 'var(--t-panel-hover)';
        event.currentTarget.style.color = state === 'error'
          ? 'var(--t-danger, #ef4444)'
          : 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.backgroundColor = state === 'copied'
          ? 'var(--t-accent-soft)'
          : state === 'error'
            ? 'var(--t-bg-card)'
            : 'var(--t-panel)';
        event.currentTarget.style.color = state === 'copied'
          ? 'var(--t-accent)'
          : state === 'error'
            ? 'var(--t-danger, #ef4444)'
            : 'var(--t-text-secondary)';
      }}
    >
      <CopyMarkdownIcon size={14} />
      {label}
    </button>
  );
}
