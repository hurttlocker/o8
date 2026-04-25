'use client';

/**
 * Mobile Orchestrator parts — leaf components and icon SVGs extracted
 * from OrchestratorView so the main file stays under the 500-line spec.
 */

import { memo, type CSSProperties } from 'react';
import type {
  MobileOrchestratorRuntime,
  MobileOrchestratorThread,
  MobileOrchestratorTranscriptEntry,
} from '@/lib/mobile/types';

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

export function SendIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </svg>
  );
}

export function runtimeLabel(runtime: MobileOrchestratorRuntime): string {
  switch (runtime) {
    case 'claude-code': return 'Claude';
    case 'codex': return 'Codex';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'opencode';
    default: return 'Brain';
  }
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
  const dotColor =
    thread.status === 'busy' ? '#FFD60A'
      : thread.status === 'ready' ? '#30D158'
        : '#706860';

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
    borderColor: active ? 'rgba(255,248,240,0.32)' : 'rgba(255,248,240,0.07)',
    background: active ? 'rgba(255,248,240,0.10)' : 'rgba(30,28,26,0.82)',
    color: '#FAF5F0',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    cursor: 'pointer',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: active ? '0 12px 24px rgba(0,0,0,0.3)' : 'none',
    transition: 'background 180ms ease, border-color 180ms ease',
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
            color: '#A09890',
          }}
        >
          {runtimeLabel(thread.runtime)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 500,
            color: '#706860',
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
          color: '#FAF5F0',
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
            color: '#706860',
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

export const TranscriptBubble = memo(function TranscriptBubble({
  entry,
}: {
  entry: MobileOrchestratorTranscriptEntry;
}) {
  if (entry.role === 'user') {
    return (
      <div
        style={{
          alignSelf: 'flex-end',
          maxWidth: '85%',
          paddingTop: 9,
          paddingRight: 14,
          paddingBottom: 9,
          paddingLeft: 14,
          borderRadius: 14,
          background: 'rgba(10,132,255,0.18)',
          color: '#FAF5F0',
          fontSize: 14,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {entry.text}
      </div>
    );
  }

  if (entry.role === 'tool') {
    return (
      <div
        style={{
          alignSelf: 'flex-start',
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
          borderColor: 'rgba(255,248,240,0.10)',
          background: 'rgba(30,28,26,0.7)',
          color: '#A09890',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.02em',
          fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
        }}
      >
        <span aria-hidden="true">{'·'}</span>
        <span>{entry.toolName ?? entry.text}</span>
      </div>
    );
  }

  if (entry.role === 'system') {
    return (
      <div
        style={{
          alignSelf: 'center',
          fontSize: 11,
          color: '#706860',
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
        maxWidth: '88%',
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(255,248,240,0.07)',
        background: 'rgba(30,28,26,0.82)',
        color: '#FAF5F0',
        fontSize: 14,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        opacity: entry.thinking ? 0.7 : 1,
        fontStyle: entry.thinking ? 'italic' : undefined,
      }}
    >
      {entry.text}
    </div>
  );
});
