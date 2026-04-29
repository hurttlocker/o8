'use client';

/**
 * #742 — DIRECTIVE row of the Context Recall Card.
 *
 * Collapsed: shows the top-priority directive title + scope chip.
 * Expanded: shows the directive body and a list of all other configured
 * directives so the operator can confirm which constraints will reach the
 * agent.
 */

import {
  Chevron,
  expandedSurfaceStyle,
  FONT_FAMILY,
  MONO_FAMILY,
  rowChromeStyle,
  rowLabelStyle,
  rowValueStyle,
  type DirectiveSummary,
} from './shared';

interface DirectiveRowProps {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  topDirective: DirectiveSummary | null;
  otherCount: number;
  allDirectives: DirectiveSummary[];
}

/**
 * #769 — Living Specs render. Mono lines, muted ink, indented slightly.
 * Tooltip on hover shows the full trailer line so the operator can read
 * past the truncated tail without expanding into a viewer.
 */
function RecentMergesList({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        paddingLeft: 8,
        borderLeftWidth: 2,
        borderLeftStyle: 'solid',
        borderLeftColor: 'var(--t-divider-subtle)',
      }}
    >
      {lines.map((line, idx) => (
        <div
          key={`${idx}-${line.slice(0, 24)}`}
          title={line}
          style={{
            fontFamily: MONO_FAMILY,
            fontSize: 10,
            lineHeight: 1.5,
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.005em',
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

export function DirectiveRow({
  open,
  onToggle,
  loading,
  topDirective,
  otherCount,
  allDirectives,
}: DirectiveRowProps) {
  const value = loading
    ? 'Loading…'
    : topDirective
      ? topDirective.title
      : 'No directives configured';

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
        <span style={rowLabelStyle}>directive</span>
        <span
          style={{
            ...rowValueStyle,
            color: topDirective ? 'var(--t-text)' : 'var(--t-text-muted)',
          }}
        >
          {value}
          {topDirective && otherCount > 0 ? (
            <span style={{ color: 'var(--t-text-faint)', fontWeight: 500, marginLeft: 6 }}>
              + {otherCount} more
            </span>
          ) : null}
        </span>
        {topDirective ? (
          <span
            style={{
              flexShrink: 0,
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              paddingTop: 2,
              paddingRight: 6,
              paddingBottom: 2,
              paddingLeft: 6,
              borderRadius: 6,
              background:
                topDirective.scope === 'global'
                  ? 'rgba(37, 99, 235, 0.10)'
                  : 'rgba(148, 163, 184, 0.12)',
              color:
                topDirective.scope === 'global' ? '#2563eb' : 'var(--t-text-muted)',
            }}
          >
            {topDirective.scope}
          </span>
        ) : null}
        <Chevron open={open} />
      </button>
      {open ? (
        <div style={expandedSurfaceStyle}>
          {topDirective?.body ? (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                fontFamily: FONT_FAMILY,
              }}
            >
              {topDirective.body}
            </div>
          ) : null}
          <RecentMergesList lines={topDirective?.recentMerges ?? []} />
          {allDirectives.length > 1 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {allDirectives.slice(0, 6).map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 10.5,
                    color: 'var(--t-text-muted)',
                    fontFamily: FONT_FAMILY,
                  }}
                >
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: '50%',
                      background:
                        d.scope === 'global' ? '#2563eb' : 'var(--t-text-faint)',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.title}
                  </span>
                  <span
                    style={{
                      color: 'var(--t-text-faint)',
                      fontSize: 9,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {d.scope}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
