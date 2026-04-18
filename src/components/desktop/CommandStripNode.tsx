'use client';

import { useState } from 'react';
import type { MobileTranscriptCommand, MobileTranscriptCommandChip } from '@/lib/mobile/types';

function chipColors(tone: MobileTranscriptCommandChip['tone']) {
  switch (tone) {
    case 'blue':
      return { color: '#1d4ed8', background: 'rgba(37, 99, 235, 0.08)', border: 'rgba(37, 99, 235, 0.16)' };
    case 'amber':
      return { color: '#b45309', background: 'rgba(249, 115, 22, 0.08)', border: 'rgba(249, 115, 22, 0.16)' };
    case 'emerald':
      return { color: '#047857', background: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.16)' };
    case 'red':
      return { color: '#b91c1c', background: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.16)' };
    default:
      return { color: '#475569', background: 'rgba(148, 163, 184, 0.08)', border: 'rgba(148, 163, 184, 0.16)' };
  }
}

export function CommandStripNode({
  command,
  timestampLabel,
}: {
  command: MobileTranscriptCommand;
  timestampLabel?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const details = command.details ?? [];
  const chips = command.chips ?? [];
  const hasDetails = details.length > 0 || chips.length > 0 || Boolean(timestampLabel);

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      width: '100%',
      paddingTop: 12,
      paddingBottom: 12,
    }}>
      <div style={{
        width: '90%',
        maxWidth: 680,
        borderRadius: 16,
        border: '1px solid rgba(148, 163, 184, 0.14)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.74), rgba(248, 250, 252, 0.9))',
        backdropFilter: 'blur(18px)',
        boxShadow: '0 14px 30px rgba(15, 23, 42, 0.05)',
        overflow: 'hidden',
      }}>
        <button
          type="button"
          onClick={() => {
            if (!hasDetails) return;
            setExpanded((value) => !value);
          }}
          aria-expanded={hasDetails ? expanded : undefined}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '10px 12px',
            border: 'none',
            background: 'transparent',
            cursor: hasDetails ? 'pointer' : 'default',
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: '#2563eb',
              boxShadow: '0 0 0 4px rgba(37, 99, 235, 0.10)',
              flexShrink: 0,
            }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{
                fontSize: 10.5,
                color: '#2563eb',
                letterSpacing: '0.04em',
                fontFamily: '"SFMono-Regular", ui-monospace, Menlo, monospace',
                whiteSpace: 'nowrap',
              }}>
                {`/${command.name}`}
              </span>
              <span style={{
                fontSize: 12,
                color: 'var(--t-text)',
                fontWeight: 600,
                lineHeight: 1.45,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {command.summary}
              </span>
            </div>
          </div>
          {hasDetails ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                flexShrink: 0,
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 180ms ease',
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          ) : null}
        </button>

        {expanded && hasDetails ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 0,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 30,
            borderTop: '1px solid rgba(148, 163, 184, 0.08)',
          }}>
            {chips.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 12 }}>
                {chips.map((chip) => {
                  const colors = chipColors(chip.tone);
                  return (
                    <span
                      key={`${chip.label}-${chip.tone ?? 'slate'}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '5px 9px',
                        borderRadius: 999,
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: colors.color,
                        background: colors.background,
                        border: `1px solid ${colors.border}`,
                        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                      }}
                    >
                      {chip.label}
                    </span>
                  );
                })}
              </div>
            ) : null}

            {details.length > 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                {details.map((detail, index) => (
                  <div
                    key={`${detail}-${index}`}
                    style={{
                      fontSize: 11.5,
                      lineHeight: 1.55,
                      color: 'var(--t-text-secondary)',
                      fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                    }}
                  >
                    {detail}
                  </div>
                ))}
              </div>
            ) : null}

            {timestampLabel ? (
              <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
                {timestampLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
