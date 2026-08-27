'use client';

export function VoiceModeButton({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const title = enabled
    ? 'Voice mode on: dictation sends and replies play aloud'
    : 'Voice mode off: dictation stays in the composer';
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={enabled}
      title={title}
      onClick={() => onChange(!enabled)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: enabled ? 'var(--t-accent-border)' : 'transparent',
        background: enabled ? 'var(--t-accent-soft)' : 'transparent',
        color: enabled ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        transition: 'color 120ms, background 120ms, border-color 120ms',
        flexShrink: 0,
      }}
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <path d="M4 10v4" />
        <path d="M8 7v10" />
        <path d="M12 4v16" />
        <path d="M16 7v10" />
        <path d="M20 10v4" />
      </svg>
    </button>
  );
}
