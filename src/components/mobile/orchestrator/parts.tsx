'use client';

/**
 * Mobile Orchestrator parts — leaf components and icon SVGs extracted
 * from OrchestratorView so the main file stays under the 500-line spec.
 */

import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  MobileOrchestratorRuntime,
  MobileOrchestratorThread,
  MobileOrchestratorTranscriptEntry,
} from '@/lib/mobile/types';
import {
  ORCHESTRATOR_RUNTIMES,
  isOrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { useTheme } from '../ThemeContext';
import { MobileMarkdown } from '@/app/mobile/mobile-markdown';
import { IconClock } from '@/app/mobile/mobile-approvals-shared';

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18 9 12l6-6" />
    </svg>
  );
}

export function StopIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/**
 * Pulsing waveform shown in place of the send icon while a long-press
 * dictation session is active. Animates via requestAnimationFrame (NOT
 * setInterval) per packet constraint — battery-friendly.
 */
export function MicWaveformIndicator({ size = 18, color = '#FF453A' }: { size?: number; color?: string }) {
  const BAR_COUNT = 4;
  const [phase, setPhase] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    const tick = (now: number) => {
      if (!mounted) return;
      setPhase(now / 1000);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const barWidth = Math.max(1, Math.round(size / 7));
  const gap = Math.max(1, Math.round(size / 10));
  const minH = Math.round(size * 0.2);
  const maxH = Math.round(size * 0.92);
  const range = maxH - minH;

  return (
    <span
      role="img"
      aria-label="Recording"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap,
        width: size,
        height: size,
      }}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const offset = i * 0.45;
        const t = (Math.sin(phase * 4 + offset) + 1) / 2; // 0..1
        const h = Math.round(minH + range * (0.35 + 0.65 * t));
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              width: barWidth,
              height: h,
              borderRadius: barWidth,
              background: color,
              transition: 'none',
            }}
          />
        );
      })}
    </span>
  );
}

export function SendIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </svg>
  );
}

export function runtimeLabel(runtime: MobileOrchestratorRuntime): string {
  return isOrchestratorRuntime(runtime)
    ? ORCHESTRATOR_RUNTIMES[runtime].shortLabel
    : 'Agent';
}

export function relativeLabel(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const ThreadCard = memo(function ThreadCard({
  thread,
  active,
  onSelect,
}: {
  thread: MobileOrchestratorThread;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const { colors } = useTheme();
  const dotColor =
    thread.status === 'busy' ? colors.amber
      : thread.status === 'ready' ? colors.success
        : thread.status === 'failed' ? colors.danger
        : colors.textTertiary;

  const cardStyle: CSSProperties = {
    flex: '0 0 auto',
    width: 200,
    height: 80,
    paddingTop: 10,
    paddingRight: 12,
    paddingBottom: 10,
    paddingLeft: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: active ? colors.accent : colors.cardBorder,
    background: colors.frostStrong,
    color: colors.text,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    cursor: 'pointer',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: active ? '0 12px 24px rgba(0,0,0,0.3)' : 'none',
    transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
  };

  return (
    <button type="button" onClick={() => onSelect(thread.id)} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, background: dotColor, flexShrink: 0 }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: colors.textSecondary,
          }}
        >
          {runtimeLabel(thread.runtime)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 500,
            color: colors.textTertiary,
            flexShrink: 0,
          }}
        >
          {relativeLabel(thread.lastMessageAt)}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.3,
          color: colors.text,
          letterSpacing: '-0.01em',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        } as CSSProperties}
      >
        {thread.title}
      </div>
      {thread.repoName ? (
        <div
          style={{
            fontSize: 10,
            color: colors.textTertiary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {thread.repoName}
        </div>
      ) : null}
    </button>
  );
});

function QueuedBadge({
  stale,
  queueId,
  onRetry,
  onDiscard,
}: {
  stale: boolean;
  queueId: string | null;
  onRetry?: (queueId: string) => void;
  onDiscard?: (queueId: string) => void;
}) {
  const { colors } = useTheme();
  const pillStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    paddingTop: 3,
    paddingRight: 8,
    paddingBottom: 3,
    paddingLeft: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.cardBorder,
    background: colors.cardBg,
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  };
  const actionButtonStyle: CSSProperties = {
    minHeight: 28,
    minWidth: 56,
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 10,
    paddingRight: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.cardBorder,
    background: colors.cardBg,
    color: colors.text,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  };
  if (stale && queueId) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <span style={pillStyle}>
          <IconClock fill={colors.textTertiary} size={11} />
          <span>Queued · {">"} 1h</span>
        </span>
        <button type="button" style={actionButtonStyle} onClick={() => onRetry?.(queueId)}>Retry</button>
        <button type="button" style={actionButtonStyle} onClick={() => onDiscard?.(queueId)}>Discard</button>
      </div>
    );
  }
  return (
    <span style={pillStyle}>
      <IconClock fill={colors.textTertiary} size={11} />
      <span>Queued</span>
    </span>
  );
}

export const TranscriptBubble = memo(function TranscriptBubble({
  entry,
  onRetryQueued,
  onDiscardQueued,
}: {
  entry: MobileOrchestratorTranscriptEntry;
  onRetryQueued?: (queueId: string) => void;
  onDiscardQueued?: (queueId: string) => void;
}) {
  const { colors, isDark } = useTheme();
  if (entry.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '82%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <div
          style={{
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            borderRadius: 18,
            borderBottomRightRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: entry.queued ? colors.textTertiary : colors.cardBorder,
            background: colors.msgUserBg,
            color: colors.text,
            fontSize: 14,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            opacity: entry.queued ? 0.78 : 1,
          }}
        >
          {entry.text}
        </div>
        {entry.queued ? (
          <QueuedBadge
            stale={entry.queueStale === true}
            queueId={entry.queueId ?? null}
            onRetry={onRetryQueued}
            onDiscard={onDiscardQueued}
          />
        ) : null}
      </div>
    );
  }

  if (entry.role === 'tool') {
    const done = entry.toolDone === true;
    const glyph = done ? '✓' : '·';
    const glyphColor = done ? colors.success : colors.textTertiary;
    return (
      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth: '88%',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 5,
          paddingRight: 10,
          paddingBottom: 5,
          paddingLeft: 10,
          borderRadius: 999,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: done ? colors.success : colors.cardBorder,
          background: isDark ? colors.frostStrong : colors.cardBg,
          color: colors.textSecondary,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.02em',
          fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
        }}
      >
        <span aria-hidden="true" style={{ color: glyphColor }}>{glyph}</span>
        <span>{entry.toolName ?? entry.text}</span>
        {entry.toolPreview ? (
          <span
            style={{
              color: colors.textTertiary,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {`— ${entry.toolPreview}`}
          </span>
        ) : null}
      </div>
    );
  }

  if (entry.role === 'system') {
    return (
      <div
        style={{
          alignSelf: 'center',
          fontSize: 11,
          color: colors.textTertiary,
          fontStyle: 'italic',
        }}
      >
        {entry.text}
      </div>
    );
  }

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        width: '100%',
        paddingTop: isDark ? 12 : 2,
        paddingRight: isDark ? 14 : 18,
        paddingBottom: isDark ? 12 : 0,
        paddingLeft: isDark ? 14 : 0,
        borderRadius: isDark ? 16 : 0,
        borderWidth: isDark ? 1 : 0,
        borderStyle: 'solid',
        borderColor: isDark ? colors.cardBorder : 'transparent',
        background: isDark ? '#161616' : 'transparent',
        opacity: entry.thinking ? 0.7 : 1,
        fontStyle: entry.thinking ? 'italic' : undefined,
      }}
    >
      <MobileMarkdown content={entry.text} textColor={colors.text} light={!isDark} />
    </div>
  );
});
