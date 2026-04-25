'use client';

/**
 * OrchestratorView — mobile Orchestrator tab.
 *
 * Layout (top to bottom):
 *   ┌──────────────────────────────────┐
 *   │ Header: title + connection chip   │
 *   │ Thread strip (horizontal, 92px)   │
 *   ├──────────────────────────────────┤
 *   │ Active thread transcript          │
 *   │ (scroll, fills remaining height)  │
 *   ├──────────────────────────────────┤
 *   │ Composer (fixed bottom)           │
 *   └──────────────────────────────────┘
 *
 * Alpha quality: read-mostly with a single composer. No mission control.
 * No multi-thread compose. No thread deletion. No "create thread" — to
 * start a new thread, dispatch from desktop.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';
import { useTheme } from './ThemeContext';
import {
  useOrchestratorMobile,
  type MobileOrchestratorConnectionState,
} from './hooks/useOrchestratorMobile';
import {
  ChevronLeftIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
  ThreadCard,
  TranscriptBubble,
} from './orchestrator/parts';

interface OrchestratorViewProps {
  onBack: () => void;
}

const POLL_INTERVAL_MS = 8_000;

function connectionLabel(state: MobileOrchestratorConnectionState): string {
  if (state === 'connected') return 'Live';
  if (state === 'connecting') return 'Connecting';
  if (state === 'reconnecting') return 'Reconnecting';
  return 'Offline';
}

function connectionDot(state: MobileOrchestratorConnectionState): string {
  if (state === 'connected') return '#30D158';
  if (state === 'connecting' || state === 'reconnecting') return '#FFD60A';
  return '#A09890';
}

export function OrchestratorView({ onBack }: OrchestratorViewProps) {
  const { colors } = useTheme();
  const [threads, setThreads] = useState<MobileOrchestratorThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  const {
    connectionState,
    turnStatus,
    transcript,
    transcriptLoading,
    errorNote,
    sendMessage,
    interrupt,
  } = useOrchestratorMobile({ activeThread });

  const fetchThreads = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const response = await fetch('/api/mobile/orchestrator/threads', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { threads?: MobileOrchestratorThread[] };
      setThreads(data.threads ?? []);
      setThreadsError(null);
    } catch (error) {
      console.log('[mobile-orchestrator] threads fetch failed', error);
      setThreadsError('Unable to load orchestrator threads.');
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchThreads();
  }, [fetchThreads]);

  // Polling fallback so the strip stays roughly current even if the user
  // doesn't pull-to-refresh.
  useEffect(() => {
    const handle = window.setInterval(() => { void fetchThreads(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [fetchThreads]);

  // Auto-pick the most recent thread on first load so the user lands on
  // SOMETHING instead of an empty stage.
  useEffect(() => {
    if (activeThreadId) return;
    if (threads.length === 0) return;
    setActiveThreadId(threads[0].id);
  }, [activeThreadId, threads]);

  // Auto-scroll transcript to bottom when entries arrive.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, transcriptLoading]);

  const handleSelectThread = useCallback((id: string) => {
    setActiveThreadId(id);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = composerDraft.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setComposerDraft('');
    // Refocus so power users can keep typing if needed.
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [composerDraft, sendMessage]);

  const handleComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const isEmpty = threads.length === 0 && !threadsLoading;
  const canSend = Boolean(activeThread?.repoPath) && composerDraft.trim().length > 0 && turnStatus !== 'busy';

  // Styles
  const headerStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12,
    paddingTop: 14, paddingRight: 18, paddingBottom: 10, paddingLeft: 18,
    color: colors.text,
  };
  const backButtonStyle: CSSProperties = {
    width: 36, height: 36, minWidth: 36, minHeight: 36,
    borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
    borderColor: colors.surfaceBorder, background: colors.surface, color: colors.text,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
  };
  const titleStackStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1,
  };
  const connectionPillStyle: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10,
    borderRadius: 999, borderWidth: 1, borderStyle: 'solid',
    borderColor: colors.surfaceBorder, background: colors.surface, color: colors.textSecondary,
    fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
    flexShrink: 0,
  };
  const stripWrapStyle: CSSProperties = {
    display: 'flex', gap: 10, overflowX: 'auto', overflowY: 'hidden',
    paddingTop: 4, paddingRight: 18, paddingBottom: 12, paddingLeft: 18,
    scrollbarWidth: 'none',
    WebkitOverflowScrolling: 'touch',
  };
  const transcriptWrapStyle: CSSProperties = {
    flex: 1, minHeight: 0, overflowY: 'auto',
    paddingTop: 8, paddingRight: 14, paddingBottom: 12, paddingLeft: 14,
    display: 'flex', flexDirection: 'column', gap: 8,
    background: 'transparent',
    WebkitOverflowScrolling: 'touch',
  };
  const composerWrapStyle: CSSProperties = {
    paddingTop: 10, paddingRight: 12,
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
    paddingLeft: 12,
    borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: colors.surfaceBorder,
    background: colors.frostBg,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    flexShrink: 0,
  };
  const composerInputRowStyle: CSSProperties = {
    display: 'flex', alignItems: 'flex-end', gap: 8,
    borderRadius: 14, borderWidth: 1, borderStyle: 'solid',
    borderColor: colors.surfaceBorder, background: 'rgba(30,28,26,0.82)',
    paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 12,
  };
  const composerTextareaStyle: CSSProperties = {
    flex: 1, minHeight: 36, maxHeight: 140,
    borderWidth: 0, background: 'transparent', color: colors.text,
    fontSize: 14, lineHeight: 1.45, resize: 'none', outline: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  };
  const sendButtonStyle: CSSProperties = {
    width: 36, height: 36, minWidth: 36, minHeight: 36,
    borderRadius: 999, borderWidth: 0,
    background: canSend ? '#0A84FF' : 'rgba(255,248,240,0.10)',
    color: canSend ? '#FFFFFF' : colors.textTertiary,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: canSend ? 'pointer' : 'default', flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 180ms ease, color 180ms ease',
  };
  const stopButtonStyle: CSSProperties = {
    ...sendButtonStyle,
    background: 'rgba(255,69,58,0.18)', color: '#FF453A', cursor: 'pointer',
  };
  const noteStyle: CSSProperties = {
    margin: 0,
    paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12,
    borderRadius: 10, borderWidth: 1, borderStyle: 'solid',
    borderColor: 'rgba(255,69,58,0.30)', background: 'rgba(255,69,58,0.10)', color: '#FF8A80',
    fontSize: 12, lineHeight: 1.45,
  };

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        minHeight: '100vh', background: colors.bg, color: colors.text,
      }}
    >
      <div style={headerStyle}>
        <button type="button" aria-label="Back" onClick={onBack} style={backButtonStyle}>
          <ChevronLeftIcon size={16} />
        </button>
        <div style={titleStackStyle}>
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: colors.text }}>
            Orchestrator
          </span>
          <span
            style={{
              fontSize: 11, color: colors.textSecondary, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {activeThread ? activeThread.title : isEmpty ? 'No active threads' : 'Pick a thread'}
          </span>
        </div>
        <div style={connectionPillStyle}>
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: connectionDot(connectionState) }} />
          {connectionLabel(connectionState)}
        </div>
      </div>

      <div style={stripWrapStyle}>
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            active={thread.id === activeThreadId}
            onSelect={handleSelectThread}
          />
        ))}
        {threadsLoading && threads.length === 0 ? (
          <div style={{ flex: '0 0 auto', width: 200, height: 80, borderRadius: 14, background: 'rgba(46,42,38,0.7)' }} />
        ) : null}
      </div>

      {threadsError ? (
        <div style={{ paddingTop: 0, paddingRight: 18, paddingBottom: 8, paddingLeft: 18 }}>
          <p style={noteStyle}>{threadsError}</p>
        </div>
      ) : null}

      <div ref={transcriptRef} style={transcriptWrapStyle}>
        {!activeThread && isEmpty ? (
          <div
            style={{
              margin: '32px auto', maxWidth: 320, padding: 16, borderRadius: 14,
              borderWidth: 1, borderStyle: 'solid', borderColor: colors.surfaceBorder,
              background: colors.surface, color: colors.textSecondary,
              fontSize: 13, lineHeight: 1.5, textAlign: 'center',
            }}
          >
            <div
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                color: colors.textTertiary, marginBottom: 6,
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              }}
            >
              <PlusIcon size={11} />
              <span>No threads</span>
            </div>
            <p style={{ margin: 0 }}>Dispatch a packet from desktop to see it here.</p>
          </div>
        ) : null}

        {transcriptLoading && transcript.length === 0 ? (
          <div style={{ alignSelf: 'flex-start', fontSize: 12, color: colors.textTertiary, fontStyle: 'italic' }}>
            Loading transcript…
          </div>
        ) : null}

        {transcript.map((entry) => (
          <TranscriptBubble key={entry.id} entry={entry} />
        ))}

        {turnStatus === 'busy' ? (
          <div
            style={{
              alignSelf: 'flex-start',
              paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12,
              borderRadius: 12, background: 'rgba(30,28,26,0.7)',
              color: colors.textSecondary, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em',
              animation: 'mobile-orchestrator-pulse 1.4s ease-in-out infinite',
            }}
          >
            Thinking…
          </div>
        ) : null}

        {errorNote ? <p style={noteStyle}>{errorNote}</p> : null}
      </div>

      {activeThread ? (
        <div style={composerWrapStyle}>
          <div style={composerInputRowStyle}>
            <textarea
              ref={composerRef}
              value={composerDraft}
              onChange={(event) => setComposerDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                activeThread.repoPath
                  ? 'Reply to the orchestrator…'
                  : 'This thread has no repo — open it on desktop to reply.'
              }
              rows={1}
              disabled={!activeThread.repoPath}
              style={composerTextareaStyle}
            />
            {turnStatus === 'busy' ? (
              <button type="button" aria-label="Stop" onClick={interrupt} style={stopButtonStyle}>
                <StopIcon size={14} />
              </button>
            ) : (
              <button type="button" aria-label="Send" onClick={handleSend} disabled={!canSend} style={sendButtonStyle}>
                <SendIcon size={16} />
              </button>
            )}
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes mobile-orchestrator-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
