'use client';

/**
 * #742 — RECENT OUTCOMES row of the Context Recall Card.
 *
 * Collapsed: shows the most recent outcome's tone (merged / partial /
 * failed / etc.) + relative timestamp + 3 status dots for the last 3 runs.
 * Expanded: lists each outcome with summary, runtime, branch, and time.
 */

import {
  Chevron,
  expandedSurfaceStyle,
  FONT_FAMILY,
  formatRelative,
  outcomeTone,
  rowChromeStyle,
  rowLabelStyle,
  rowValueStyle,
  type RecentOutcome,
} from './shared';

interface OutcomesRowProps {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  error: string | null;
  outcomes: RecentOutcome[];
}

export function OutcomesRow({ open, onToggle, loading, error, outcomes }: OutcomesRowProps) {
  const summary = (() => {
    if (loading) return 'Loading…';
    if (error) return 'Unable to load outcomes';
    if (outcomes.length === 0) return 'No prior runs on this repo';
    const last = outcomes[0];
    const tone = outcomeTone(last.outcome, last.reviewApproved);
    return `${tone.label} · ${formatRelative(last.completedAt)}`;
  })();

  return (
    <div
      data-packet-row
      style={{
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...rowChromeStyle,
          background: open ? 'var(--t-divider-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = 'var(--t-divider-subtle)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={rowLabelStyle}>recent</span>
        <span
          style={{
            ...rowValueStyle,
            color: outcomes.length > 0 ? 'var(--t-text)' : 'var(--t-text-muted)',
          }}
        >
          {summary}
        </span>
        {outcomes.length > 0 ? (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              flexShrink: 0,
              paddingRight: 4,
            }}
          >
            {outcomes.slice(0, 3).map((o) => {
              const tone = outcomeTone(o.outcome, o.reviewApproved);
              return (
                <span
                  key={o.id}
                  title={`${tone.label} · ${formatRelative(o.completedAt)}`}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: tone.dot,
                  }}
                />
              );
            })}
          </span>
        ) : null}
        <Chevron open={open} />
      </button>
      {open && outcomes.length > 0 ? (
        <div style={{ ...expandedSurfaceStyle, gap: 4 }}>
          {outcomes.map((o) => {
            const tone = outcomeTone(o.outcome, o.reviewApproved);
            return (
              <div
                key={o.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontFamily: FONT_FAMILY,
                  fontSize: 10.5,
                  lineHeight: 1.4,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: tone.dot,
                    flexShrink: 0,
                    marginTop: 5,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: 'var(--t-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    } as React.CSSProperties}
                  >
                    {o.summary || `${tone.label} run`}
                  </div>
                  <div
                    style={{
                      marginTop: 1,
                      fontSize: 9.5,
                      color: 'var(--t-text-faint)',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {tone.label.toUpperCase()} · {o.runtime}
                    {o.branch ? ` · ${o.branch}` : ''}
                    {' · '}
                    {formatRelative(o.completedAt)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
