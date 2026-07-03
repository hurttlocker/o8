'use client';

/**
 * Brain→Fable transparency card (2026-07-02).
 *
 * Renders one inline block per `cortex_ask` the orchestrator made on a METERED
 * backend — the visible face of the Brain offload: the operator watches the
 * fixed-cost Brain do the reading so the metered model never pays to.
 *
 * Collapsed (default): a one-line chip in the ToolCallChip vocabulary —
 * "BRAIN → <question, truncated>". Expanding reveals the titled citations
 * (O8ScratchChat pill idiom), "M cited · N considered", retrieval ms, and a
 * compact offload line (approx tokens the digest put into the metered window
 * vs what a raw read of the considered sources would have cost) when the
 * server reported `consideredChars` — omitted gracefully when not.
 *
 * Gating happens in the parent (DesktopAgentMessage via
 * `isMeteredBrainFeedCall`) — this component just renders a populated feed.
 * Pure display logic lives in `../brain-feed.ts`.
 */

import { useState } from 'react';
import type { BrainFeedCitation, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { brainOffload, formatTokenCount } from '@/components/desktop/thoughts/brain-feed';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';

function compactLine(text: string, max = 84): string {
  const singleLine = sanitizeTranscriptText(text).replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max - 1)}…`;
}

function cleanExcerpt(excerpt: string): string {
  return sanitizeTranscriptText(excerpt).replace(/[«»]/g, '').trim();
}

function citationLabel(citation: BrainFeedCitation): string {
  return citation.title?.trim() || `${citation.kind}:${citation.rowId}`;
}

/** The same open-book glyph the Brain ToolCallChip renders (kind 'read') —
 *  continuity between the plain chip and the transparency card. */
function BrainGlyph({ accent }: { accent: string }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke={accent}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, display: 'block' }}
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--t-text-faint)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        flexShrink: 0,
        display: 'block',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function BrainFeedCard({ toolCall }: { toolCall: MobileTranscriptToolCall }) {
  const [open, setOpen] = useState(false);
  const [expandedCite, setExpandedCite] = useState<number | null>(null);

  const feed = toolCall.brainFeed;
  if (!feed) return null;

  const question = feed.question.trim() || 'brain question';
  const running = toolCall.status === 'running' || toolCall.status === 'calling';
  const offload = brainOffload(feed, toolCall.result?.length);
  const considered = feed.sourcesConsidered;
  const metaParts: string[] = [
    `${feed.citations.length} cited`,
    ...(typeof considered === 'number' && considered > 0 ? [`${considered} considered`] : []),
    ...(typeof feed.retrievalMs === 'number' && feed.retrievalMs > 0 ? [`${Math.round(feed.retrievalMs)}ms retrieval`] : []),
    ...(feed.cacheHit ? [`cached (${feed.cacheHit})`] : []),
  ];
  const selectedCitation = expandedCite !== null ? feed.citations[expandedCite] ?? null : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '92%', width: '100%' }}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`Brain fed the orchestrator: ${question}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          alignSelf: 'flex-start',
          paddingTop: 0,
          paddingRight: 8,
          paddingBottom: 0,
          paddingLeft: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
          color: running ? 'var(--t-text)' : 'var(--t-text-secondary)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 10.5,
          letterSpacing: '-0.005em',
          maxWidth: '100%',
        }}
      >
        <BrainGlyph accent={running ? '#FF5A1F' : 'var(--t-text-muted)'} />
        <span
          style={{
            fontWeight: 600,
            color: running ? '#FF5A1F' : 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            fontSize: 9,
            flexShrink: 0,
          }}
        >
          Brain
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
            fontSize: 10,
            color: 'var(--t-text-secondary)',
          }}
        >
          {compactLine(question)}
        </span>
        <ChevronGlyph open={open} />
      </button>

      {open ? (
        <div
          style={{
            width: 'min(560px, 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 12,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            borderRadius: 14,
            background: 'color-mix(in srgb, var(--t-bg-card) 92%, transparent)',
            boxShadow: 'var(--t-shadow-card, 0 18px 45px rgba(15, 23, 42, 0.08))',
            color: 'var(--t-text)',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 300,
                color: 'var(--t-text-muted)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Brain fed the orchestrator
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 13.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                lineHeight: 1.35,
                color: 'var(--t-text)',
                wordBreak: 'break-word',
              }}
            >
              {sanitizeTranscriptText(question)}
            </div>
          </div>

          <div
            style={{
              fontSize: 10.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--t-text-faint)',
            }}
          >
            {metaParts.join(' · ')}
          </div>

          {feed.citations.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {feed.citations.map((citation, index) => {
                const label = citationLabel(citation);
                const active = expandedCite === index;
                return (
                  <button
                    key={`${citation.kind}-${citation.rowId}-${index}`}
                    type="button"
                    title={label}
                    aria-expanded={active}
                    onClick={() => setExpandedCite((current) => (current === index ? null : index))}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      maxWidth: 260,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: active ? 'var(--t-divider)' : 'var(--t-divider-subtle)',
                      borderRadius: 999,
                      background: active ? 'var(--t-input-bg)' : 'transparent',
                      color: 'var(--t-text-secondary)',
                      fontFamily: 'var(--font-sans-system)',
                      fontSize: 10.5,
                      fontWeight: 300,
                      letterSpacing: '-0.1px',
                      paddingTop: 3,
                      paddingRight: 9,
                      paddingBottom: 3,
                      paddingLeft: 9,
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 8.5,
                        fontWeight: 300,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--t-text-faint)',
                        flexShrink: 0,
                      }}
                    >
                      {citation.kind}
                    </span>
                    <span
                      style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {sanitizeTranscriptText(label)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: 'var(--t-text-faint)',
              }}
            >
              No sources cited for this answer.
            </div>
          )}

          {selectedCitation ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                paddingTop: 10,
                paddingRight: 10,
                paddingBottom: 10,
                paddingLeft: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                borderRadius: 10,
                background: 'var(--t-bg-card)',
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 400,
                  letterSpacing: '-0.1px',
                  color: 'var(--t-text)',
                  wordBreak: 'break-word',
                }}
              >
                {sanitizeTranscriptText(citationLabel(selectedCitation))}
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 300,
                  color: 'var(--t-text-faint)',
                  fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                }}
              >
                {selectedCitation.kind} · {selectedCitation.rowId}
              </div>
              {selectedCitation.excerpt?.trim() ? (
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 300,
                    lineHeight: 1.5,
                    letterSpacing: '-0.1px',
                    color: 'var(--t-text-secondary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 140,
                    overflowY: 'auto',
                  }}
                >
                  {cleanExcerpt(selectedCitation.excerpt)}
                </div>
              ) : null}
            </div>
          ) : null}

          {offload ? (
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: 'var(--t-text-faint)',
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
                paddingTop: 8,
              }}
            >
              {`Offload: ~${formatTokenCount(offload.windowTokens)} tok into the metered window · raw read ~${formatTokenCount(offload.absorbedTokens)} tok`}
              {offload.absorbedTokens >= offload.windowTokens * 2
                ? ` · ${Math.round(offload.absorbedTokens / offload.windowTokens)}x absorbed by the Brain`
                : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
