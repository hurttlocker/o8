'use client';

import { useMemo, useState } from 'react';
import type { CompactionTrigger } from '@/lib/runtimes/compaction-detector';

interface CompactionNodeProps {
  compactedCount?: number;
  summary?: string;
  trigger?: CompactionTrigger;
  tokensBefore?: number;
  tokensAfter?: number;
  timestampLabel?: string;
}

function formatTokenCount(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

function headerLabel(compactedCount: number | undefined, trigger: CompactionTrigger | undefined) {
  if (typeof compactedCount === 'number') {
    return `${compactedCount} messages compressed`;
  }
  if (trigger === 'manual') return 'Context compacted manually';
  if (trigger === 'auto') return 'Context auto-compacted';
  return 'Context compacted';
}

function triggerLabel(trigger: CompactionTrigger | undefined) {
  if (trigger === 'manual') return 'Manual';
  if (trigger === 'auto') return 'Auto';
  return 'Detected';
}

export function CompactionNode({
  compactedCount,
  summary,
  trigger,
  tokensBefore,
  tokensAfter,
  timestampLabel,
}: CompactionNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const displaySummary = useMemo(() => (
    (summary ?? '')
      .replace(/<\/?compacted_context>/g, '')
      .trim()
  ), [summary]);

  const formattedBefore = formatTokenCount(tokensBefore);
  const formattedAfter = formatTokenCount(tokensAfter);
  const hasDetails = Boolean(displaySummary)
    || Boolean(formattedBefore)
    || Boolean(formattedAfter)
    || Boolean(timestampLabel)
    || Boolean(trigger);

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      paddingTop: 16,
      paddingBottom: 16,
      width: '100%',
    }}>
      <div style={{
        width: '90%',
        maxWidth: 680,
        borderRadius: 14,
        border: '1px solid rgba(59,130,246,0.12)',
        background: 'rgba(59,130,246,0.03)',
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
      }}>
        <button
          onClick={() => {
            if (!hasDetails) return;
            setIsExpanded((value) => !value);
          }}
          aria-expanded={hasDetails ? isExpanded : undefined}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 16,
            paddingRight: 16,
            border: 'none',
            background: 'transparent',
            cursor: hasDetails ? 'pointer' : 'default',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 0,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(59,130,246,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
              <path d="M7 3l5 3 5-3" />
              <path d="M7 21l5-3 5 3" />
            </svg>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 0,
            }}>
              <span style={{
                fontSize: 13,
                fontWeight: 500,
                color: '#94a3b8',
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {headerLabel(compactedCount, trigger)}
              </span>
              {(formattedBefore || formattedAfter || trigger) ? (
                <span style={{
                  fontSize: 11,
                  color: '#64748b',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {trigger ? `${triggerLabel(trigger)} compaction` : 'Compaction event'}
                  {(formattedBefore || formattedAfter) ? ` • ${formattedBefore ?? '—'} → ${formattedAfter ?? '—'} tokens` : ''}
                </span>
              ) : null}
            </div>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}>
            {timestampLabel ? (
              <span style={{
                fontSize: 11,
                color: '#64748b',
              }}>
                {timestampLabel}
              </span>
            ) : null}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#cbd5e1"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                opacity: hasDetails ? 1 : 0.45,
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 200ms ease',
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </button>

        {isExpanded && hasDetails ? (
          <div style={{
            paddingTop: 0,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            borderTop: '1px solid rgba(59,130,246,0.06)',
          }}>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 12,
            }}>
              <div style={{
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 999,
                background: 'rgba(59,130,246,0.05)',
                border: '1px solid rgba(59,130,246,0.08)',
                fontSize: 11,
                color: '#64748b',
              }}>
                {trigger ? `${triggerLabel(trigger)} trigger` : 'Compaction'}
              </div>
              {(formattedBefore || formattedAfter) ? (
                <div style={{
                  paddingTop: 6,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 999,
                  background: 'rgba(59,130,246,0.05)',
                  border: '1px solid rgba(59,130,246,0.08)',
                  fontSize: 11,
                  color: '#64748b',
                }}>
                  {`${formattedBefore ?? '—'} → ${formattedAfter ?? '—'} tokens`}
                </div>
              ) : null}
            </div>

            {displaySummary ? (
              <div style={{
                marginTop: 12,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 10,
                background: 'rgba(59,130,246,0.03)',
                border: '1px solid rgba(59,130,246,0.06)',
              }}>
                <div style={{
                  fontSize: 12,
                  color: '#64748b',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.7,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}>
                  {displaySummary}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
