'use client';

/**
 * TurnSummaryCard — rolled-up digest of a completed orchestrator turn.
 *
 * Fires on `busy → ready` transitions in the orchestrator stream. Sits inline
 * in the transcript right after the last assistant message of the turn and
 * collapses 40+ tool deltas into one digestible block. Wraps ChatActionCard
 * as the file-touched handle.
 *
 * Issue: #1096 (Codex-borrow turn-summary cards). Pairs with #1095.
 */

import { useState } from 'react';
import { ChatActionCard } from './ChatActionCard';

export type TurnSummary = {
  /** Anchor — the assistant message id this summary belongs to. */
  assistantMessageId: string;
  /** Elapsed turn time in ms. */
  elapsedMs: number;
  /** Total tool invocations in the turn. */
  toolCount: number;
  /** First 2–3 distinct tool names; the rest collapse into "+N". */
  toolNames: string[];
  /** Distinct tool name count for the +N tail. */
  toolNameTotal: number;
  /** Files edited during the turn (from /api/review/workspace at turn end). */
  filesEditedCount: number;
  /** File paths so the inner ChatActionCard can Undo + Review. */
  filePaths: string[];
  /** Token running-total delta during the turn. */
  tokensUsed: number;
  /** Repo root for the inner ChatActionCard. */
  repoPath: string | null;
};

type Props = {
  summary: TurnSummary;
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

function formatTokens(value: number): string {
  if (value <= 0) return '0';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function TurnSummaryCard({ summary }: Props) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = formatElapsed(summary.elapsedMs);
  const toolPreview = summary.toolNames.slice(0, 3).join(', ');
  const toolOverflow = Math.max(0, summary.toolNameTotal - summary.toolNames.slice(0, 3).length);

  const stats: { key: string; value: string }[] = [
    { key: 'tools', value: summary.toolCount === 0 ? '0 tools' : `${summary.toolCount} ${summary.toolCount === 1 ? 'tool' : 'tools'}` },
    { key: 'files', value: summary.filesEditedCount === 0 ? '0 files' : `${summary.filesEditedCount} ${summary.filesEditedCount === 1 ? 'file' : 'files'}` },
    { key: 'tokens', value: `${formatTokens(summary.tokensUsed)} tokens` },
  ];

  return (
    <div
      role="group"
      aria-label="Turn summary"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'var(--t-input-bg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 9,
          paddingRight: 10,
          paddingBottom: 9,
          paddingLeft: 12,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            color: 'var(--t-text-muted)',
            flexShrink: 0,
          }}
        >
          <ClockIcon />
        </span>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              color: 'var(--t-text)',
              fontSize: 13.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.25,
            }}
          >
            Worked for {elapsed}
          </span>
          {toolPreview ? (
            <span
              style={{
                color: 'var(--t-text-muted)',
                fontSize: 9.5,
                fontWeight: 260,
                letterSpacing: '-0.4px',
                lineHeight: 1.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {toolPreview}
              {toolOverflow > 0 ? ` +${toolOverflow}` : ''}
            </span>
          ) : null}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
            fontFamily: 'SF Mono, Menlo, Monaco, monospace',
            fontSize: 10.5,
            color: 'var(--t-text-muted)',
            letterSpacing: '0.2px',
          }}
        >
          {stats.map((stat, idx) => (
            <span key={stat.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {idx > 0 ? <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span> : null}
              <span>{stat.value}</span>
            </span>
          ))}
        </div>

        <DetailsToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      </div>

      {summary.filesEditedCount > 0 ? (
        <div
          style={{
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider)',
            background: 'transparent',
          }}
        >
          <ChatActionCard
            filesEditedCount={summary.filesEditedCount}
            repoPath={summary.repoPath}
            filePaths={summary.filePaths}
            firstFilePath={summary.filePaths[0] ?? null}
          />
        </div>
      ) : null}

      {expanded ? (
        <div
          style={{
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider)',
            paddingTop: 8,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
            color: 'var(--t-text-muted)',
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          Scroll up to the tool deltas above this card to see the full turn detail.
        </div>
      ) : null}
    </div>
  );
}

function DetailsToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={expanded ? 'Hide details' : 'Show details'}
      aria-label={expanded ? 'Hide details' : 'Show details'}
      aria-expanded={expanded}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 22,
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        borderWidth: 0,
        borderRadius: 7,
        background: hover ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        fontSize: 10.5,
        letterSpacing: '0.2px',
        flexShrink: 0,
        transition: 'background 120ms ease',
      }}
    >
      {expanded ? 'Hide' : 'Details'}
    </button>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5 V8 L10.5 9.5" />
    </svg>
  );
}
