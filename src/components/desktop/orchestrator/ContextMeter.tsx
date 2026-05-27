'use client';

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatTokens } from '@/lib/util/format-tokens';
import { approxTokens } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { useOrchestratorContextResidency } from './context-residency';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const CONTEXT_LIMIT = 1_000_000;
const MONO_STACK = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";
const JAKARTA_STACK = 'var(--font-sans-system)';

// Static baselines for o8's orchestrator surface. We don't have a live
// token-meter for system prompt + tool definitions, so we approximate
// from production telemetry. The "Other" row absorbs any drift vs the
// backend running total so the bar always sums truthfully.
const SYSTEM_PROMPT_TOKENS = 5_200;
const TOOLS_TOKENS = 6_400;

const meterLabel = (value: number) => formatTokens(value).replace(/K$/u, 'k');

type CategoryKey = 'system' | 'tools' | 'conversation' | 'other';

interface CategoryRow {
  key: CategoryKey;
  label: string;
  color: string;
  tokens: number;
}

function approxPayloadTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return approxTokens(value);
  try {
    return approxTokens(JSON.stringify(value));
  } catch {
    return approxTokens(String(value));
  }
}

function tokensFor(entry: MobileTranscriptEntry): number {
  if (typeof entry.compaction?.tokensAfter === 'number') {
    return entry.compaction.tokensAfter;
  }
  if (entry.tokens) {
    return Math.max(1, (entry.tokens.input ?? 0) + (entry.tokens.output ?? 0));
  }
  const textTokens = approxTokens(entry.text ?? '');
  const thinkingTokens = entry.thinking ? approxTokens(entry.thinking) : 0;
  const toolTokens = (entry.toolCalls ?? []).reduce((sum, call) => {
    return sum
      + approxTokens(call.name ?? '')
      + approxPayloadTokens(call.args)
      + approxPayloadTokens(call.preview)
      + approxPayloadTokens(call.result);
  }, 0);
  return Math.max(1, textTokens + thinkingTokens + toolTokens);
}

export function ContextMeter({ tokenCount, runningTotal, onClick }: { tokenCount: number; runningTotal: number; onClick?: () => void }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const residency = useOrchestratorContextResidency();
  const estimatedConversationTokens = useMemo(() => {
    const messages = residency?.messages ?? [];
    return messages.reduce((sum, entry) => sum + tokensFor(entry), 0);
  }, [residency?.messages]);
  const estimatedTotal = SYSTEM_PROMPT_TOKENS + TOOLS_TOKENS + estimatedConversationTokens;
  const effectiveRunningTotal = Math.max(runningTotal, estimatedTotal);
  const usingEstimate = runningTotal <= 0 && effectiveRunningTotal > 0;

  const handleToggle = useCallback(() => {
    onClick?.();
    setOpen((prev) => !prev);
  }, [onClick]);

  useEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setAnchor({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8,
      width: rect.width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickAway = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handleClickAway);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClickAway);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const percent = Math.round((Math.max(0, Math.min(CONTEXT_LIMIT, effectiveRunningTotal)) / CONTEXT_LIMIT) * 100);
  const tone = percent >= 85 ? 'critical' : percent >= 60 ? 'warning' : 'idle';
  const label = `${meterLabel(effectiveRunningTotal)} / 1M · ${percent}%`;
  const ringColor = tone === 'critical' ? '#FF5A1F' : tone === 'warning' ? 'var(--t-text-muted)' : 'var(--t-text-faint)';
  const circumference = 43.98;
  const dashOffset = circumference - ((Math.max(0, Math.min(100, percent)) / 100) * circumference);
  const titlePrefix = usingEstimate ? 'Estimated context usage' : 'Context usage';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        aria-label={tokenCount > 0 ? `${titlePrefix} ${label}. ${meterLabel(tokenCount)} tokens added last turn.` : `${titlePrefix} ${label}.`}
        data-context-meter
        title={tokenCount > 0 ? `${titlePrefix} ${label} · +${meterLabel(tokenCount)} last turn` : `${titlePrefix} ${label}`}
        style={{
          width: 24,
          height: 24,
          paddingTop: 0,
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          borderRadius: 999,
          borderWidth: 0,
          background: open ? 'var(--t-hover)' : 'transparent',
          color: ringColor,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(event) => {
          if (!open) event.currentTarget.style.background = 'var(--t-hover)';
        }}
        onMouseLeave={(event) => {
          if (!open) event.currentTarget.style.background = 'transparent';
        }}
      >
        <svg width={17} height={17} viewBox="0 0 18 18" aria-hidden="true" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
          <circle
            cx="9"
            cy="9"
            r="7"
            fill="none"
            stroke="var(--t-divider-subtle)"
            strokeWidth="3"
          />
          <circle
            cx="9"
            cy="9"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            opacity={percent > 0 ? 1 : 0}
          />
        </svg>
      </button>
      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
          <ContextPopover
            ref={popoverRef}
            anchorLeft={anchor.left}
            anchorBottom={anchor.bottom}
            runningTotal={effectiveRunningTotal}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )
        : null}
    </>
  );
}

interface ContextPopoverProps {
  anchorLeft: number;
  anchorBottom: number;
  runningTotal: number;
  onClose: () => void;
}

const ContextPopover = forwardRef<HTMLDivElement, ContextPopoverProps>(function ContextPopover(
  { anchorLeft, anchorBottom, runningTotal, onClose },
  ref,
) {
  const residency = useOrchestratorContextResidency();
  const [hoveredKey, setHoveredKey] = useState<CategoryKey | null>(null);
  const conversationTokens = useMemo(() => {
    const messages = residency?.messages ?? [];
    return messages.reduce((sum, entry) => sum + tokensFor(entry), 0);
  }, [residency?.messages]);

  const rows: CategoryRow[] = useMemo(() => {
    const knownBaseline = SYSTEM_PROMPT_TOKENS + TOOLS_TOKENS;
    const baseTotal = Math.max(runningTotal, knownBaseline + conversationTokens);
    const otherTokens = Math.max(0, baseTotal - knownBaseline - conversationTokens);
    return [
      { key: 'system', label: 'System prompt', color: '#9ca3af', tokens: SYSTEM_PROMPT_TOKENS },
      { key: 'tools', label: 'Tools & MCP', color: '#a78bfa', tokens: TOOLS_TOKENS },
      { key: 'conversation', label: 'Conversation', color: '#f97316', tokens: conversationTokens },
      { key: 'other', label: 'Other', color: '#cbd5e1', tokens: otherTokens },
    ];
  }, [conversationTokens, runningTotal]);

  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const realTotal = Math.max(totalTokens, runningTotal);
  const percent = realTotal > 0 ? Math.min(100, Math.round((realTotal / CONTEXT_LIMIT) * 100)) : 0;

  const visibleRows = rows.filter((row) => row.tokens > 0);
  const totalForBar = visibleRows.reduce((sum, row) => sum + row.tokens, 0) || 1;

  const popoverWidth = 340;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Context breakdown"
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(anchorLeft, window.innerWidth - popoverWidth - 8)),
        bottom: anchorBottom,
        width: popoverWidth,
        background: 'var(--t-panel-solid, #ffffff)',
        backdropFilter: 'saturate(140%) blur(18px)',
        WebkitBackdropFilter: 'saturate(140%) blur(18px)',
        color: 'var(--t-text)',
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        boxShadow: '0 16px 40px rgba(15, 23, 42, 0.18)',
        fontFamily: JAKARTA_STACK,
        zIndex: 9999,
        overflow: 'hidden',
      } as React.CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 12,
          paddingRight: 12,
          paddingBottom: 8,
          paddingLeft: 14,
        }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
          Context
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close context breakdown"
          style={{
            width: 22,
            height: 22,
            borderRadius: 999,
            borderWidth: 0,
            background: 'var(--t-hover, rgba(15, 23, 42, 0.06))',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            lineHeight: 1,
            fontWeight: 400,
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 2,
            paddingLeft: 0,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 14,
          paddingRight: 14,
          paddingBottom: 8,
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          color: 'var(--t-text-faint)',
          fontFamily: MONO_STACK,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{percent}% Full</span>
        <span>{`~${meterLabel(realTotal)} / 1M Tokens`}</span>
      </div>

      {/* Track + colored fill. The track is the full popover-width row at 8px
        * tall. The fill is positioned absolutely on top, sized to `percent` of
        * the track, and split into per-category segments. Mirrors Cursor's
        * left-anchored fill aesthetic. */}
      <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12 }}>
        <div
          style={{
            position: 'relative',
            height: 8,
            borderRadius: 999,
            background: 'var(--t-divider-subtle)',
            overflow: 'hidden',
          }}
          aria-hidden
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${percent}%`,
              display: 'flex',
              alignItems: 'stretch',
              gap: 1,
              transition: 'width 220ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {visibleRows.map((row) => {
              const dim = hoveredKey !== null && hoveredKey !== row.key;
              return (
                <span
                  key={row.key}
                  onMouseEnter={() => setHoveredKey(row.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                  style={{
                    flex: row.tokens / totalForBar,
                    background: row.color,
                    opacity: dim ? 0.22 : 1,
                    transition: 'opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
                    cursor: 'default',
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          paddingBottom: 6,
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider-subtle)',
        }}
      >
        {rows.map((row) => {
          const dim = hoveredKey !== null && hoveredKey !== row.key;
          const empty = row.tokens === 0;
          return (
            <div
              key={row.key}
              onMouseEnter={() => { if (!empty) setHoveredKey(row.key); }}
              onMouseLeave={() => setHoveredKey(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 6,
                paddingRight: 14,
                paddingBottom: 6,
                paddingLeft: 14,
                fontSize: 13.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                lineHeight: 1.25,
                color: empty ? 'var(--t-text-faint)' : 'var(--t-text)',
                opacity: dim ? 0.45 : 1,
                transition: 'opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: row.color,
                    opacity: empty ? 0.5 : 1,
                    flexShrink: 0,
                  }}
                />
                <span style={{ letterSpacing: '-0.005em' }}>{row.label}</span>
              </span>
              <span
                style={{
                  fontFamily: MONO_STACK,
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 9.5,
                  fontWeight: 260,
                  letterSpacing: '-0.4px',
                  color: empty ? 'var(--t-text-faint)' : 'var(--t-text-faint)',
                }}
              >
                {meterLabel(row.tokens)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
