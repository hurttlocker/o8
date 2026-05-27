import type { ReactNode } from 'react';

const GEOMETRY = 'cubic-bezier(0.22, 1, 0.36, 1)';

export function TimelineButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        position: 'relative',
        width: 24,
        height: 24,
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-hover)',
        color: 'var(--t-text)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: `background 140ms ${GEOMETRY}, border-color 140ms ${GEOMETRY}, transform 140ms ${GEOMETRY}`,
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-accent-soft)';
        e.currentTarget.style.borderColor = 'var(--t-accent-border)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--t-panel-hover)';
        e.currentTarget.style.borderColor = 'var(--t-panel-border)';
        e.currentTarget.style.transform = 'none';
      }}
    >
      {icon}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: 44,
          height: 44,
          transform: 'translate(-50%, -50%)',
        }}
      />
    </button>
  );
}
