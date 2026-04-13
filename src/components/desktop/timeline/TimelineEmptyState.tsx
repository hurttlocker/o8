import { motion } from 'framer-motion';
import { ExpandIcon } from './icons';

export function TimelineEmptyState({
  onExpand,
  repoName,
}: {
  onExpand?: () => void;
  repoName?: string | null;
}) {
  const previewSegments = [
    { left: 2, width: 10, opacity: 0.42, height: 5, tone: 'neutral' },
    { left: 14, width: 18, opacity: 0.14, height: 8, tone: 'accent' },
    { left: 35, width: 8, opacity: 0.24, height: 6, tone: 'neutral' },
    { left: 46, width: 20, opacity: 0.11, height: 10, tone: 'accent' },
    { left: 69, width: 12, opacity: 0.3, height: 6, tone: 'neutral' },
    { left: 84, width: 11, opacity: 0.16, height: 7, tone: 'accent' },
  ] as const;

  return (
    <motion.div
      key="timeline-empty"
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 8,
        paddingRight: 16,
        paddingBottom: 10,
        paddingLeft: 90,
        background: 'transparent',
        borderBottom: '1px solid var(--t-divider-subtle)',
        color: 'var(--t-text)',
        fontFamily: 'system-ui, sans-serif',
        letterSpacing: '-0.01em',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          minWidth: 0,
        }}>
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--t-text-faint)',
            whiteSpace: 'nowrap',
          }}>
            Waiting for activity
          </span>
        </div>
        <div style={{
          minWidth: 0,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
          }}>
            {repoName ? `${repoName} activity will appear here once agents are active.` : 'Commits, PRs, and CI runs will appear here once agents are active.'}
          </div>
          <div style={{
            fontSize: 11,
            lineHeight: 1.35,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.01em',
          }}>
            This rail fills in as work starts, then fades back to the live timeline without a jump.
          </div>
        </div>
        {onExpand ? (
          <button
            type="button"
            onClick={onExpand}
            aria-label="Open timeline"
            style={{
              minHeight: 44,
              paddingTop: 0,
              paddingRight: 14,
              paddingBottom: 0,
              paddingLeft: 14,
              borderRadius: 12,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: 'pointer',
              fontFamily: 'system-ui, sans-serif',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              flexShrink: 0,
              transition: 'background 140ms ease, border-color 140ms ease, transform 140ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--t-accent-soft)';
              e.currentTarget.style.borderColor = 'var(--t-accent-border)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--t-panel-translucent)';
              e.currentTarget.style.borderColor = 'var(--t-panel-border)';
              e.currentTarget.style.transform = 'none';
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--t-text-secondary)' }}>
              <ExpandIcon />
            </span>
            Open timeline
          </button>
        ) : null}
      </div>

      <div style={{
        position: 'relative',
        height: 18,
        borderRadius: 14,
        border: '1px solid var(--t-divider-subtle)',
        background: 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card) 100%)',
        overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px var(--t-divider-subtle)',
      }}>
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--t-divider-subtle)',
          opacity: 0.38,
        }} />
        <div style={{
          position: 'absolute',
          inset: '3px 8px',
          pointerEvents: 'none',
        }}>
          {previewSegments.map((segment, index) => (
            <div
              key={`${segment.left}-${index}`}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: `${segment.left}%`,
                width: `${segment.width}%`,
                top: `calc((100% - ${segment.height}px) / 2)`,
                height: segment.height,
                borderRadius: 999,
                background: segment.tone === 'accent' ? 'var(--t-accent)' : 'var(--t-text-secondary)',
                opacity: segment.opacity,
                filter: 'blur(0.1px)',
              }}
            />
          ))}
          <div style={{
            position: 'absolute',
            left: '62%',
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--t-accent)',
            opacity: 0.14,
            borderRadius: 999,
          }} />
        </div>
      </div>
    </motion.div>
  );
}
