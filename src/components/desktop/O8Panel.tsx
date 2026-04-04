'use client';

/**
 * O8Panel — Wide contextual panel (50% screen width).
 *
 * V1 shell. Will hold PR diffs, file changes, and governance views.
 * Rendered as the third state of the right panel morph button.
 */

interface O8PanelProps {
  onClose: () => void;
}

export function O8Panel({ onClose }: O8PanelProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--t-bg)',
      borderLeft: '1px solid var(--t-divider)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 40,
        paddingLeft: 16,
        paddingRight: 8,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '-0.01em',
          color: 'var(--t-text-strong)',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
          o8
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            transition: 'background 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content — V1 placeholder */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
      }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          color: 'var(--t-text-faint)',
          fontSize: 13,
          letterSpacing: '-0.01em',
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
            <rect x="3" y="3" width="7" height="18" rx="2" />
            <rect x="14" y="3" width="7" height="18" rx="2" />
          </svg>
          <span>Select a PR file to view changes</span>
        </div>
      </div>
    </div>
  );
}
