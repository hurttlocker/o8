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

function readMeta(summary: string | undefined, field: string) {
  return summary?.match(new RegExp(`${field}="([^"]+)"`, 'i'))?.[1];
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

  const inferredCount = Number(readMeta(summary, 'turns'));
  const compactedTurns = Number.isFinite(inferredCount) ? inferredCount : compactedCount;
  const stamp = readMeta(summary, 'at') ?? timestampLabel;
  const displaySummary = useMemo(() => (
    (summary ?? '')
      .replace(/<\/?compacted_context\b[^>]*>/g, '')
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
            minHeight: 18,
            padding: '0 10px',
            border: 'none',
            background: 'transparent',
            cursor: hasDetails ? 'pointer' : 'default',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: '#f97316', boxShadow: '0 0 0 3px rgba(249,115,22,0.12)', flexShrink: 0 }} />
            <span style={{
              fontSize: 10.5,
              lineHeight: '18px',
              color: '#9a3412',
              letterSpacing: '0.04em',
              fontFamily: '"SFMono-Regular", ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {`(COMPACTED · ${compactedTurns ?? 'AUTO'} TURNS${stamp ? ` · ${stamp}` : ''})`}
            </span>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <svg
              width="11"
              height="11"
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
