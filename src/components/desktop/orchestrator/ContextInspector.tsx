'use client';

/**
 * ContextInspector — right-side collapsible panel that lists every turn
 * currently in the orchestrator context window (#587).
 *
 * Each row shows timestamp + role + preview + token count + evict/pin
 * action. An orange dot marks the turn currently being generated.
 *
 * Evict/pin are client-side UI state for v1. See context-residency.tsx
 * for the rationale — the backend Claude Code session is not yet aware
 * of evicted turns. The inspector's "IN CONTEXT" header reflects the
 * adjusted local view (total minus evicted). The ContextMeter pill in
 * the chat footer continues to show the real backend running total.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { formatTokens } from '@/lib/util/format-tokens';
import { approxTokens } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { useOrchestratorContextResidency } from './context-residency';

const PANEL_WIDTH = 340;
const MONO_STACK = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";
const JAKARTA_STACK = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';

interface ContextInspectorProps {
  open: boolean;
  onClose: () => void;
}

interface RowDerived {
  entry: MobileTranscriptEntry;
  tokens: number;
  preview: string;
  timeLabel: string;
  roleLabel: string;
  kind: 'turn' | 'compaction';
  isActive: boolean;
  isEvicted: boolean;
  isPinned: boolean;
}

function roleLabelFor(entry: MobileTranscriptEntry): string {
  if (entry.type === 'compaction' || entry.role === 'system' && /compact/i.test(entry.text)) {
    return 'compaction';
  }
  if (entry.role === 'tool') return 'tool';
  if (entry.role === 'system') return 'system';
  if (entry.role === 'user') return 'user';
  return 'assistant';
}

function timeLabelFor(entry: MobileTranscriptEntry): string {
  if (entry.timestampLabel) return entry.timestampLabel;
  if (entry.timestamp) {
    return new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return '';
}

function previewFor(entry: MobileTranscriptEntry): string {
  if (entry.type === 'compaction' || roleLabelFor(entry) === 'compaction') {
    const trigger = entry.compaction?.trigger;
    const delta = typeof entry.compaction?.tokensBefore === 'number'
      && typeof entry.compaction?.tokensAfter === 'number'
        ? ` · ${formatTokens(entry.compaction.tokensBefore)} → ${formatTokens(entry.compaction.tokensAfter)}`
        : '';
    const label = trigger ? `(${trigger} summarized)` : '(summarized)';
    return `${label}${delta}`;
  }
  const text = (entry.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  if (entry.toolCalls?.length) {
    const names = entry.toolCalls.map((call) => call.name).join(', ');
    return `[tool: ${names}]`;
  }
  if (entry.thinking?.trim()) return '[thinking]';
  return '[empty]';
}

function tokensFor(entry: MobileTranscriptEntry): number {
  if (typeof entry.compaction?.tokensAfter === 'number') {
    return entry.compaction.tokensAfter;
  }
  const textTokens = approxTokens(entry.text ?? '');
  const thinkingTokens = entry.thinking ? approxTokens(entry.thinking) : 0;
  const toolTokens = (entry.toolCalls ?? []).reduce((sum, call) => sum + approxTokens(call.name ?? ''), 0);
  return Math.max(1, textTokens + thinkingTokens + toolTokens);
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const value = tokens / 1000;
    return value >= 10 ? `${Math.round(value)}k` : `${value.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${tokens}`;
}

function PinIcon({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
        <path
          d="M16 3l5 5-4 1-2 6 3 3-6-2-4 4v-5l-2-1 6-2 1-4-4-1 7-4z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M12 17v5" />
      <path d="M9 10.76A2 2 0 0 1 10.24 9H14a2 2 0 0 1 2 2v2.41" />
      <path d="M5 17h14" />
      <path d="M9 10v4" />
      <path d="M15 10v4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function actionPillStyle(active: boolean): CSSProperties {
  return {
    height: 20,
    paddingTop: 0,
    paddingRight: 7,
    paddingBottom: 0,
    paddingLeft: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: active ? 'var(--t-accent-border)' : 'var(--t-border)',
    background: active ? 'var(--t-accent-soft)' : 'transparent',
    color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    fontFamily: JAKARTA_STACK,
    transition: 'opacity 140ms ease, color 140ms ease, border-color 140ms ease, background 140ms ease',
  };
}

function RowActions({
  isEvicted,
  isPinned,
  isActive,
  onEvictToggle,
  onPinToggle,
}: {
  isEvicted: boolean;
  isPinned: boolean;
  isActive: boolean;
  onEvictToggle: () => void;
  onPinToggle: () => void;
}): ReactNode {
  return (
    <div
      data-context-inspector-actions
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        opacity: isPinned || isEvicted ? 1 : 0,
        transition: 'opacity 140ms ease',
      }}
    >
      <button
        type="button"
        onClick={onPinToggle}
        title={isPinned ? 'Unpin' : 'Pin'}
        aria-label={isPinned ? 'Unpin turn' : 'Pin turn'}
        style={actionPillStyle(isPinned)}
      >
        <PinIcon filled={isPinned} />
        <span>{isPinned ? 'pinned' : 'pin'}</span>
      </button>
      {isActive ? null : (
        <button
          type="button"
          onClick={onEvictToggle}
          title={isEvicted ? 'Restore to context view' : 'Evict from context view'}
          aria-label={isEvicted ? 'Restore turn' : 'Evict turn'}
          style={actionPillStyle(isEvicted)}
        >
          {isEvicted ? 'restore' : 'evict'}
        </button>
      )}
    </div>
  );
}

export function ContextInspector({ open, onClose }: ContextInspectorProps) {
  const residency = useOrchestratorContextResidency();

  const rows: RowDerived[] = useMemo(() => {
    if (!residency) return [];
    return residency.messages.map((entry) => {
      const isEvicted = residency.evictedIds.has(entry.id);
      const isPinned = residency.pinnedIds.has(entry.id);
      const isActive = residency.activeAssistantId === entry.id;
      const kind = roleLabelFor(entry) === 'compaction' ? 'compaction' : 'turn';
      return {
        entry,
        tokens: tokensFor(entry),
        preview: previewFor(entry),
        timeLabel: timeLabelFor(entry),
        roleLabel: roleLabelFor(entry),
        kind,
        isActive,
        isEvicted,
        isPinned,
      };
    });
  }, [residency]);

  const { totalTurns, totalEvictedTokens, inContextTokens } = useMemo(() => {
    let turns = 0;
    let tokens = 0;
    let evictedTokens = 0;
    for (const row of rows) {
      turns += 1;
      tokens += row.tokens;
      if (row.isEvicted) evictedTokens += row.tokens;
    }
    const real = residency?.runningTotal ?? 0;
    // Prefer the backend running total when available (more accurate), but
    // still show the evicted delta so operators see the "savings".
    const base = real > 0 ? real : tokens;
    const inContext = Math.max(0, base - evictedTokens);
    return { totalTurns: turns, totalEvictedTokens: evictedTokens, inContextTokens: inContext };
  }, [rows, residency?.runningTotal]);

  if (!open) return null;

  return (
    <div
      data-orchestrator-context-inspector
      style={{
        width: PANEL_WIDTH,
        minWidth: PANEL_WIDTH,
        borderLeftWidth: 1,
        borderLeftStyle: 'solid',
        borderLeftColor: 'var(--t-divider-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
        background: 'var(--t-chat-surface-bg, var(--t-bg))',
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          flexShrink: 0,
          background: 'var(--t-panel)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--t-text-faint)',
              fontFamily: JAKARTA_STACK,
            }}
          >
            In context
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: 'var(--t-text-muted)',
              letterSpacing: '0.01em',
              fontFamily: MONO_STACK,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {totalTurns} {totalTurns === 1 ? 'turn' : 'turns'}
            {' · '}
            {formatTokenCount(inContextTokens)} tokens
            {totalEvictedTokens > 0 ? ` · −${formatTokenCount(totalEvictedTokens)}` : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close context inspector"
          title="Close context inspector"
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--t-bg-card)';
            event.currentTarget.style.color = 'var(--t-text)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = 'var(--t-text-muted)';
          }}
        >
          <CloseIcon />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {rows.length === 0 ? (
          <div
            style={{
              padding: 20,
              fontSize: 12,
              fontWeight: 400,
              lineHeight: 1.5,
              color: 'var(--t-text-faint)',
              fontFamily: JAKARTA_STACK,
              textAlign: 'center',
            }}
          >
            No turns in context yet.
          </div>
        ) : (
          rows.map((row) => (
            <ContextInspectorRow
              key={row.entry.id}
              row={row}
              onEvictToggle={() => {
                if (!residency) return;
                if (row.isEvicted) residency.unevict(row.entry.id);
                else residency.evict(row.entry.id);
              }}
              onPinToggle={() => residency?.togglePin(row.entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ContextInspectorRow({
  row,
  onEvictToggle,
  onPinToggle,
}: {
  row: RowDerived;
  onEvictToggle: () => void;
  onPinToggle: () => void;
}) {
  const isCompaction = row.kind === 'compaction';
  const roleColor = row.isEvicted
    ? 'var(--t-text-faint)'
    : isCompaction
      ? 'var(--t-text-muted)'
      : 'var(--t-text)';
  const previewColor = row.isEvicted ? 'var(--t-text-faint)' : 'var(--t-text-secondary)';
  const tokenColor = row.isEvicted ? 'var(--t-text-faint)' : 'var(--t-text-muted)';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        paddingTop: 9,
        paddingRight: 12,
        paddingBottom: 9,
        paddingLeft: 14,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        opacity: row.isEvicted ? 0.55 : 1,
        transition: 'opacity 160ms ease',
      }}
      onMouseEnter={(event) => {
        const actions = event.currentTarget.querySelector<HTMLElement>('[data-context-inspector-actions]');
        if (actions) actions.style.opacity = '1';
      }}
      onMouseLeave={(event) => {
        const actions = event.currentTarget.querySelector<HTMLElement>('[data-context-inspector-actions]');
        if (actions && !row.isPinned && !row.isEvicted) actions.style.opacity = '0';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            flexShrink: 0,
            background: row.isActive ? '#FF5A1F' : 'transparent',
          }}
        />
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--t-text-faint)',
            letterSpacing: '0.02em',
            fontFamily: MONO_STACK,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            minWidth: 38,
          }}
        >
          {row.timeLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: roleColor,
            letterSpacing: '-0.005em',
            fontFamily: JAKARTA_STACK,
            flexShrink: 0,
            minWidth: 64,
            textTransform: 'lowercase',
          }}
        >
          {row.roleLabel}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            fontWeight: 400,
            color: previewColor,
            letterSpacing: '-0.005em',
            fontFamily: JAKARTA_STACK,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            lineHeight: 1.4,
          }}
          title={row.preview}
        >
          {row.preview}
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 500,
            color: tokenColor,
            letterSpacing: '0.01em',
            fontFamily: MONO_STACK,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            minWidth: 36,
            textAlign: 'right',
          }}
        >
          {formatTokenCount(row.tokens)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingLeft: 52 }}>
        <RowActions
          isEvicted={row.isEvicted}
          isPinned={row.isPinned}
          isActive={row.isActive}
          onEvictToggle={onEvictToggle}
          onPinToggle={onPinToggle}
        />
      </div>
    </div>
  );
}
