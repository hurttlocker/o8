'use client';

/**
 * AgentTranscriptSheet — read-only bottom sheet showing the transcript
 * of a spawned agent (codex / claude-code / gemini / opencode).
 *
 * v1 mobile model: orchestrator dispatches and steers, mobile only watches.
 * No composer, no interrupt button — those live on desktop.
 */

import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from './ThemeContext';

const MobileDiffViewer = lazy(async () => ({
  default: (await import('./MobileDiffViewer')).MobileDiffViewer,
}));

interface AgentTranscriptEntry {
  id: string;
  role: string;
  text: string;
  type?: string;
  timestamp?: number;
  timestampLabel?: string;
  toolName?: string;
  filePath?: string;
}

interface AgentTranscriptSheetProps {
  open: boolean;
  onClose: () => void;
  sessionKey: string | null;
  agentName: string;
  runtime: string;
  status: string;
  workspace?: string;
}

function getWsToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
}

export const AgentTranscriptSheet = memo(function AgentTranscriptSheet({
  open,
  onClose,
  sessionKey,
  agentName,
  runtime,
  status,
  workspace,
}: AgentTranscriptSheetProps) {
  const { colors, isDark } = useTheme();
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const canViewDiff = Boolean(workspace && sessionKey);

  const fetchTranscript = useCallback(async () => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      const token = getWsToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=200`, {
        cache: 'no-store',
        headers,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      const data = await response.json() as { transcript?: AgentTranscriptEntry[] };
      setEntries(data.transcript ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read transcript');
    } finally {
      setLoading(false);
    }
  }, [sessionKey]);

  useEffect(() => {
    if (open && sessionKey) {
      void fetchTranscript();
    } else {
      setEntries([]);
      setError(null);
    }
  }, [open, sessionKey, fetchTranscript]);

  // Auto-scroll to bottom when entries arrive.
  useEffect(() => {
    if (!open) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const grouped = useMemo(() => entries, [entries]);

  const statusColor = status === 'running' ? colors.success
    : status === 'idle' ? colors.textTertiary
      : colors.amber;

  const sheetStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '88vh',
    minHeight: '60vh',
    background: colors.frostStrong,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    transform: open ? 'translateY(0)' : 'translateY(100%)',
    transition: 'transform 320ms cubic-bezier(0.32, 0.72, 0, 1)',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Agent transcript: ${agentName}`}
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        background: 'rgba(0,0,0,0.4)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 240ms ease',
      }}
    >
      <div ref={sheetRef} style={sheetStyle} onClick={(event) => event.stopPropagation()}>
        <div
          style={{
            paddingTop: 14, paddingRight: 18, paddingBottom: 12, paddingLeft: 18,
            borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: colors.border,
            display: 'flex', alignItems: 'center', gap: 10,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 4, height: 32, borderRadius: 999, background: statusColor, flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {agentName}
            </div>
            <div style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2, fontWeight: 500 }}>
              {runtime} · {status}{workspace ? ` · ${workspace.split('/').pop()}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            style={{
              minWidth: 60, minHeight: 32,
              borderRadius: 16, borderWidth: 1, borderStyle: 'solid',
              borderColor: colors.surfaceBorder,
              background: 'transparent',
              color: colors.textSecondary,
              fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>

        <div
          ref={transcriptRef}
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            paddingTop: 14, paddingRight: 16, paddingBottom: 14, paddingLeft: 16,
            display: 'flex', flexDirection: 'column', gap: 10,
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {loading && entries.length === 0 ? (
            <div style={{ alignSelf: 'center', fontSize: 12, color: colors.textTertiary, fontStyle: 'italic', marginTop: 24 }}>
              Loading transcript…
            </div>
          ) : null}

          {error ? (
            <div
              style={{
                padding: '10px 12px', borderRadius: 10,
                borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255,69,58,0.3)',
                background: 'rgba(255,69,58,0.08)', color: '#FF8A80',
                fontSize: 12, lineHeight: 1.45,
              }}
            >
              {error}
            </div>
          ) : null}

          {!loading && !error && entries.length === 0 ? (
            <div style={{ alignSelf: 'center', fontSize: 13, color: colors.textTertiary, marginTop: 32, textAlign: 'center', maxWidth: 280 }}>
              No transcript yet. Spawned agents emit messages as they work — check back in a moment.
            </div>
          ) : null}

          {grouped.map((entry) => {
            const isUser = entry.role === 'user';
            const isTool = entry.role === 'tool' || entry.type === 'tool';
            const text = entry.text || (entry.toolName ? `${entry.toolName}${entry.filePath ? ` · ${entry.filePath}` : ''}` : '');
            const toolBg = isDark ? 'rgba(48,209,88,0.10)' : 'rgba(34,197,94,0.10)';
            const toolBorder = isDark ? 'rgba(48,209,88,0.24)' : 'rgba(34,197,94,0.24)';
            const assistantBg = isDark ? colors.frostStrong : colors.cardBg;
            const showAssistantRing = isDark && !isUser && !isTool;
            return (
              <div
                key={entry.id}
                style={{
                  alignSelf: isUser ? 'flex-end' : 'flex-start',
                  maxWidth: '88%',
                }}
              >
                <div
                  style={{
                    paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12,
                    borderRadius: isUser ? 16 : 12,
                    borderWidth: isTool || showAssistantRing || (isDark && isUser) ? 1 : 0,
                    borderStyle: 'solid',
                    borderColor: isTool ? toolBorder : showAssistantRing || (isDark && isUser) ? colors.cardBorder : 'transparent',
                    background: isUser ? colors.msgUserBg : isTool ? toolBg : assistantBg,
                    color: colors.text,
                    fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {isTool && entry.toolName ? (
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: colors.success, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 4 }}>
                      {entry.toolName}
                    </div>
                  ) : null}
                  {text}
                </div>
                {entry.timestampLabel ? (
                  <div style={{ fontSize: 10, color: colors.textTertiary, marginTop: 2, paddingLeft: isUser ? 0 : 4, paddingRight: isUser ? 4 : 0, textAlign: isUser ? 'right' : 'left' }}>
                    {entry.timestampLabel}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div
          style={{
            paddingTop: 10, paddingRight: 18, paddingBottom: 10, paddingLeft: 18,
            borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: colors.border,
            background: colors.cardBg,
            fontSize: 11, color: colors.textSecondary, lineHeight: 1.45,
            flexShrink: 0,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          {canViewDiff ? (
            <button
              type="button"
              onClick={() => setDiffOpen(true)}
              onTouchEnd={(event) => {
                setDiffOpen(true);
                event.preventDefault();
              }}
              style={{
                alignSelf: 'flex-start',
                minHeight: 36, paddingTop: 8, paddingBottom: 8, paddingLeft: 14, paddingRight: 14,
                borderRadius: 12,
                borderWidth: 1, borderStyle: 'solid', borderColor: colors.surfaceBorder,
                background: colors.cardBg,
                color: colors.text,
                fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
              }}
            >
              View diff
            </button>
          ) : null}
          <span>Read-only on mobile. Steer this agent from the Orchestrator on desktop.</span>
        </div>

        {diffOpen && canViewDiff ? (
          <Suspense fallback={null}>
            <MobileDiffViewer
              open
              onClose={() => setDiffOpen(false)}
              source={{ kind: 'worktree', sessionKey, worktreePath: workspace ?? null }}
              title={agentName}
              subtitle={runtime}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
});
