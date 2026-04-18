'use client';

import { useState } from 'react';
import type { MobileTranscriptCommand, MobileTranscriptCommandChip } from '@/lib/mobile/types';

const BODY_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, monospace';
const INLINE_CODEISH_SOURCE = '(`[^`]+`|(?:~?/)?[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+|/[A-Za-z0-9._-]+|\\b\\d[\\d,.]*(?:\\s*(?:->|→)\\s*\\d[\\d,.]*)?\\b)';
const INLINE_CODEISH_PATTERN = new RegExp(`(${INLINE_CODEISH_SOURCE})`, 'g');
const INLINE_CODEISH_MATCH = new RegExp(`^${INLINE_CODEISH_SOURCE}$`);

function chipTone(tone: MobileTranscriptCommandChip['tone']) {
  switch (tone) {
    case 'blue':
      return 'var(--t-accent)';
    case 'amber':
      return 'var(--t-warning, #f59e0b)';
    case 'emerald':
      return 'var(--t-success, #16a34a)';
    case 'red':
      return 'var(--t-danger, #ef4444)';
    default:
      return 'var(--t-text-muted)';
  }
}

function renderInlineText(text: string, keyPrefix: string) {
  return text.split(INLINE_CODEISH_PATTERN).filter(Boolean).map((part, index) => {
    const content = part.startsWith('`') && part.endsWith('`') ? part.slice(1, -1) : part;
    if (!INLINE_CODEISH_MATCH.test(part)) {
      return <span key={`${keyPrefix}-${index}`}>{part}</span>;
    }
    return (
      <span
        key={`${keyPrefix}-${index}`}
        style={{
          fontFamily: MONO_FONT,
          fontSize: '0.96em',
          color: 'var(--t-text)',
        }}
      >
        {content}
      </span>
    );
  });
}

export function CommandStripNode({
  command,
  timestampLabel,
}: {
  command: MobileTranscriptCommand;
  timestampLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const details = command.details ?? [];
  const chips = command.chips ?? [];
  const hasDetails = details.length > 0 || chips.length > 0 || Boolean(timestampLabel);

  return (
    <div
      style={{
        width: '100%',
        paddingTop: 6,
        paddingBottom: 6,
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (!hasDetails) return;
          setExpanded((value) => !value);
        }}
        aria-expanded={hasDetails ? expanded : undefined}
        title={command.summary}
        style={{
          width: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 2,
          paddingRight: 8,
          paddingBottom: 2,
          paddingLeft: 2,
          border: 'none',
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: hasDetails ? 'pointer' : 'default',
          textAlign: 'left',
          fontSize: 11.5,
          lineHeight: 1.45,
          fontStyle: 'italic',
          fontWeight: 400,
          letterSpacing: '-0.005em',
          fontFamily: BODY_FONT,
        }}
      >
        <span style={{ opacity: 0.5, flexShrink: 0 }} aria-hidden="true">
          &middot;
        </span>
        <span
          style={{
            flexShrink: 0,
            color: 'var(--t-text)',
            fontFamily: MONO_FONT,
            fontSize: 10.75,
          }}
        >
          {`/${command.name}`}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--t-text-faint)' }}> - </span>
          {renderInlineText(command.summary, `summary-${command.name}`)}
        </span>
        {hasDetails ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--t-text-faint)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              flexShrink: 0,
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms ease',
            }}
            aria-hidden="true"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        ) : null}
      </button>

      {expanded && hasDetails ? (
        <div
          style={{
            marginTop: 6,
            marginLeft: 12,
            paddingLeft: 10,
            borderLeft: '1px solid var(--t-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {chips.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {chips.map((chip) => {
                const tone = chipTone(chip.tone);
                return (
                  <span
                    key={`${chip.label}-${chip.tone ?? 'slate'}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 22,
                      paddingTop: 0,
                      paddingRight: 8,
                      paddingBottom: 0,
                      paddingLeft: 8,
                      borderRadius: 8,
                      border: `1px solid color-mix(in srgb, ${tone} 22%, var(--t-border))`,
                      background: `color-mix(in srgb, ${tone} 10%, transparent)`,
                      color: tone,
                      fontSize: 10.5,
                      fontWeight: 600,
                      fontFamily: BODY_FONT,
                    }}
                  >
                    {chip.label}
                  </span>
                );
              })}
            </div>
          ) : null}

          {details.length > 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {details.map((detail, index) => (
                <div
                  key={`${detail}-${index}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 6,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    color: 'var(--t-text-muted)',
                    fontFamily: BODY_FONT,
                  }}
                >
                  <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }} aria-hidden="true">
                    &middot;
                  </span>
                  <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {renderInlineText(detail, `detail-${index}`)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {timestampLabel ? (
            <span
              style={{
                fontSize: 10,
                color: 'var(--t-text-faint)',
                fontFamily: MONO_FONT,
              }}
            >
              {timestampLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
