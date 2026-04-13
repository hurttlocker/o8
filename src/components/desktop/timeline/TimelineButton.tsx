import type { ReactNode } from 'react';

export function TimelineButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-hover)',
        color: 'var(--t-text)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 140ms ease, border-color 140ms ease, transform 140ms ease',
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-accent-soft)';
        e.currentTarget.style.borderColor = 'var(--t-accent-border)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--t-panel-hover)';
        e.currentTarget.style.borderColor = 'var(--t-panel-border)';
        e.currentTarget.style.transform = 'none';
      }}
    >
      {icon}
    </button>
  );
}
