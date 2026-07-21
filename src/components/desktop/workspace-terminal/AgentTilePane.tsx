'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { orchestratorRuntimeTone, agentDisplayLabel } from '@/lib/orchestrator/display';
import {
  ORCHESTRATOR_RUNTIME_IDS,
  getRuntimeCapability,
  isOrchestratorRuntime,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { transcriptStore } from '@/lib/transcripts/store';
import { useTranscript } from '@/lib/transcripts/useTranscript';

interface AgentTilePaneProps {
  sessionKey: string;
  agent: FleetAgent | null;
  focused: boolean;
  onClose: (sessionKey: string) => void;
  onFocus: (sessionKey: string) => void;
}

type VisualStatus = 'running' | 'waiting' | 'idle' | 'error';

const STATUS_META: Record<VisualStatus, { color: string; label: string }> = {
  running: { color: '#22c55e', label: 'Running' },
  waiting: { color: '#f59e0b', label: 'Waiting' },
  idle: { color: '#94a3b8', label: 'Idle' },
  error: { color: '#ef4444', label: 'Error' },
};

function classifyStatus(rawStatus?: string): VisualStatus {
  const value = (rawStatus ?? '').toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'error';
  if (value.includes('wait') || value.includes('approval') || value.includes('pending')) return 'waiting';
  if (value.includes('running') || value.includes('active') || value.includes('working')) return 'running';
  return 'idle';
}

function inferRuntime(sessionKey: string, rawRuntime?: string): OrchestratorRuntime {
  const normalized = (rawRuntime ?? '').toLowerCase();
  if (isOrchestratorRuntime(normalized)) return normalized;
  for (const runtime of ORCHESTRATOR_RUNTIME_IDS) {
    const capability = getRuntimeCapability(runtime);
    if (normalized === capability.label.toLowerCase()
      || sessionKey.startsWith(`${runtime}-owned:`)
      || sessionKey.startsWith(`${runtime}:`)) {
      return runtime;
    }
  }
  if (normalized.includes('claude')) return 'claude-code';
  return 'codex';
}

function displayName(agent: FleetAgent | null, sessionKey: string): string {
  // Canonical label — never an id slice. Falls back to the runtime's human
  // name ("Codex") rather than a raw `codex-owned:...` key.
  return agentDisplayLabel({ name: agent?.name, sessionKey });
}

function roleLabel(role: MobileTranscriptEntry['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'user') return 'User';
  if (role === 'tool') return 'Tool';
  return 'System';
}

function entryContent(entry: MobileTranscriptEntry): string {
  const text = entry.text.trim();
  if (text) return text;
  if (entry.compaction?.summary?.trim()) return entry.compaction.summary.trim();
  const toolCalls = entry.toolCalls ?? [];
  return toolCalls.length > 0 ? toolCalls.map((toolCall) => `tool: ${toolCall.name}`).join('\n') : '';
}

// Spring curve matches Apple HIG (stiffness 400, damping 30) — used for the
// composer reveal animation when a lane flips to running/awaiting_input.
const COMPOSER_SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const;
const TRANSCRIPT_STEER_LOADING_TIMEOUT_MS = 10_000;

function canSteerAgent(agent: FleetAgent | null): boolean {
  return (agent?.status ?? '').toLowerCase() === 'running';
}

function AgentTilePaneBase({ sessionKey, agent, focused, onClose, onFocus }: AgentTilePaneProps) {
  const slice = useTranscript(sessionKey);
  const entries = slice.messages;
  const loading = slice.status === 'loading' || slice.status === 'idle';
  const error = slice.status === 'error' ? slice.error ?? 'Unable to load transcript.' : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // Fix #4: synchronous guard so held-Enter can't double-fire before setState flushes
  const sendingRef = useRef(false);
  const loadingFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const name = useMemo(() => displayName(agent, sessionKey), [agent, sessionKey]);
  const runtime = useMemo(() => inferRuntime(sessionKey, agent?.runtime), [agent?.runtime, sessionKey]);
  const runtimeTone = useMemo(() => orchestratorRuntimeTone(runtime), [runtime]);
  const status = useMemo(() => classifyStatus(agent?.status), [agent?.status]);
  const canSteer = canSteerAgent(agent);
  const trimmedDraft = draft.trim();
  const canSend = canSteer && !sending && trimmedDraft.length > 0;
  const lastEntryKey = entries.length > 0 ? `${entries[entries.length - 1]?.id}:${entryContent(entries[entries.length - 1]!)}` : '';

  // Fix #1: keep a ref in sync with latest agent so submitSteer re-derives
  // canSteer at call time, not at callback-creation time.
  const agentRef = useRef(agent);
  useEffect(() => { agentRef.current = agent; }, [agent]);

  const clearTranscriptLoadingFallback = useCallback(() => {
    if (!loadingFallbackRef.current) return;
    clearTimeout(loadingFallbackRef.current);
    loadingFallbackRef.current = null;
  }, []);

  const submitSteer = useCallback(async () => {
    const message = trimmedDraft;
    // Fix #1: re-derive canSteer from the latest agent ref to avoid stale closure
    const canSteerNow = canSteerAgent(agentRef.current);
    // Fix #4: check sendingRef synchronously before any setState to prevent held-Enter race
    if (!message || !canSteerNow || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    setDraft('');
    try {
      const response = await fetch('/api/runtime/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'steer',
          surfaceId: sessionKey,
          message,
        }),
      });
      const payload = await response
        .json()
        .catch(() => null) as { ok?: boolean; note?: string; error?: string } | null;
      if (!response.ok || payload?.ok === false) {
        const note = payload?.error ?? payload?.note ?? response.statusText ?? 'Unable to send steer.';
        setSendError(note);
        return;
      }
      // Fix #5: set transcript to loading but fall back to idle after 10s if WS push never arrives
      clearTranscriptLoadingFallback();
      transcriptStore.setStatus(sessionKey, 'loading');
      loadingFallbackRef.current = setTimeout(() => {
        loadingFallbackRef.current = null;
        if (transcriptStore.getSlice(sessionKey).status !== 'loading') return;
        transcriptStore.setStatus(sessionKey, 'idle');
      }, TRANSCRIPT_STEER_LOADING_TIMEOUT_MS);
    } catch (err) {
      // Draft already cleared above; just surface the error
      setSendError(err instanceof Error ? err.message : 'Unable to send steer.');
    } finally {
      sendingRef.current = false;
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [clearTranscriptLoadingFallback, sessionKey, trimmedDraft]);

  const handleTextareaKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      // Cmd/Ctrl+Enter or plain Enter both submit; Shift+Enter inserts newline.
      event.preventDefault();
      void submitSteer();
    },
    [submitSteer],
  );

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submitSteer();
    },
    [submitSteer],
  );

  // When the lane stops accepting input, drop any error so the composer
  // doesn't carry stale state into the next live run.
  useEffect(() => {
    if (!canSteer) setSendError(null);
  }, [canSteer]);

  useEffect(() => {
    if (slice.status !== 'fresh') return;
    if (transcriptStore.getSlice(sessionKey).status !== 'fresh') return;
    clearTranscriptLoadingFallback();
  }, [clearTranscriptLoadingFallback, sessionKey, slice.status]);

  useEffect(() => () => {
    clearTranscriptLoadingFallback();
  }, [clearTranscriptLoadingFallback, sessionKey]);

  // One-shot seed for agents not in the workspace bootstrap list. After this,
  // WS pushes via transcriptStore keep the slice live — no per-agent polling.
  useEffect(() => {
    if (slice.status !== 'idle') return;
    void bootstrapTranscripts([sessionKey]);
  }, [sessionKey, slice.status]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [lastEntryKey]);

  return (
    <div
      onMouseDown={() => onFocus(sessionKey)}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderRadius: 14, borderWidth: 1, borderStyle: 'solid',
        borderColor: focused ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: 'var(--t-bg-card)',
        boxShadow: focused ? '0 18px 38px rgba(37, 99, 235, 0.12)' : '0 12px 28px rgba(15, 23, 42, 0.06)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 36, minHeight: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 10,
          borderBottomWidth: 1, borderBottomStyle: 'solid',
          borderBottomColor: focused ? 'var(--t-accent-border)' : 'var(--t-border)',
          background: focused ? 'var(--t-panel)' : 'var(--t-bg-card)',
        }}
      >
        <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              width: 18, height: 18, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: runtimeTone.background, color: runtimeTone.color, flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5.5" width="7" height="13" rx="2.25" />
              <rect x="13.5" y="5.5" width="7" height="13" rx="2.25" />
            </svg>
          </span>
          <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              title={name}
              style={{
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em',
              }}
            >
              {name}
            </div>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8,
                borderRadius: 12, borderWidth: 1, borderStyle: 'solid', borderColor: runtimeTone.border,
                background: runtimeTone.background, color: runtimeTone.color, fontSize: 10, fontWeight: 700, lineHeight: 1,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: runtimeTone.dot, flexShrink: 0 }} />
              {runtimeTone.label}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span
            title={STATUS_META[status].label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: STATUS_META[status].color, fontSize: 10, fontWeight: 700 }}
          >
            <span
              style={{
                width: 8, height: 8, borderRadius: 999, background: STATUS_META[status].color,
                boxShadow: status === 'running' ? `0 0 0 3px ${STATUS_META[status].color}22` : 'none', flexShrink: 0,
              }}
            />
            {STATUS_META[status].label}
          </span>
          <button
            type="button"
            aria-label={`Close ${name} tile`}
            title="Close tile"
            onClick={(event) => { event.stopPropagation(); onClose(sessionKey); }}
            style={{
              width: 44, height: 44, marginTop: -4, marginRight: -4, marginBottom: -4, marginLeft: 0,
              borderRadius: 12, borderWidth: 0, background: 'transparent', color: 'var(--t-text-secondary)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--t-panel)';
              event.currentTarget.style.color = 'var(--t-text)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
              event.currentTarget.style.color = 'var(--t-text-secondary)';
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="cortex-scroll-fade-y cortex-themed-scroll"
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
          paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, background: 'var(--t-panel)',
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
              color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.5,
            }}
          >
            {loading ? 'Loading transcript…' : error ?? 'No transcript yet.'}
          </div>
        ) : entries.map((entry) => {
          const content = entryContent(entry);
          if (!content) return null;
          return (
            <div
              key={entry.id}
              style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12,
                borderRadius: 14, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-border)', background: 'var(--t-bg-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span
                  style={{
                    color: entry.role === 'assistant' ? runtimeTone.color : 'var(--t-text-secondary)',
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}
                >
                  {roleLabel(entry.role)}
                </span>
                {entry.timestampLabel ? (
                  <span style={{ color: 'var(--t-text-secondary)', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>
                    {entry.timestampLabel}
                  </span>
                ) : null}
              </div>
              <div style={{ color: 'var(--t-text)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {content}
              </div>
            </div>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {canSteer ? (
          <motion.form
            key="steer-composer"
            onSubmit={handleFormSubmit}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={COMPOSER_SPRING}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              paddingTop: 10,
              paddingRight: 10,
              paddingBottom: 10,
              paddingLeft: 10,
              borderTopWidth: 1,
              borderTopStyle: 'solid',
              borderTopColor: focused ? 'var(--t-accent-border)' : 'var(--t-border)',
              background: 'var(--t-bg-card)',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 8,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-border)',
                background: 'var(--t-input-bg)',
                paddingTop: 6,
                paddingRight: 6,
                paddingBottom: 6,
                paddingLeft: 10,
              }}
            >
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleTextareaKeyDown}
                placeholder="Steer this agent…"
                rows={1}
                disabled={sending}
                aria-label={`Steer ${name}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 32,
                  maxHeight: 140,
                  resize: 'none',
                  borderWidth: 0,
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  fontFamily: 'var(--font-sans-system)',
                  outline: 'none',
                  paddingTop: 6,
                  paddingRight: 0,
                  paddingBottom: 6,
                  paddingLeft: 0,
                }}
              />
              <button
                type="submit"
                disabled={!canSend}
                aria-label={`Send steer to ${name}`}
                title={canSend ? 'Send (Enter)' : 'Type a steer to send'}
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: canSend ? 'var(--t-accent-border)' : 'var(--t-border)',
                  background: canSend ? 'var(--t-accent)' : 'var(--t-panel)',
                  color: canSend ? '#ffffff' : 'var(--t-text-secondary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: canSend ? 'pointer' : 'default',
                  opacity: canSend ? 1 : 0.7,
                  transition: 'background 160ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms cubic-bezier(0.22, 1, 0.36, 1), color 160ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              >
                {sending ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3a9 9 0 1 0 9 9" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 256 256" aria-hidden="true">
                    <path
                      d="M223.87,114l-168-95.89A16,16,0,0,0,32.93,37.32L57.85,128,32.93,218.7A16,16,0,0,0,48,240a16.13,16.13,0,0,0,7.92-2.1l167.95-96A16,16,0,0,0,223.87,114Zm-168,110L78.07,144H136a8,8,0,0,0,0-16H78.07L55.85,32l.06,0L216,128Z"
                      fill="currentColor"
                    />
                  </svg>
                )}
              </button>
            </div>
            {sendError ? (
              <div
                role="alert"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#ef4444',
                  paddingTop: 0,
                  paddingRight: 4,
                  paddingBottom: 0,
                  paddingLeft: 4,
                }}
              >
                {sendError}
              </div>
            ) : (
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: 'var(--t-text-secondary)',
                  paddingTop: 0,
                  paddingRight: 4,
                  paddingBottom: 0,
                  paddingLeft: 4,
                  letterSpacing: '-0.005em',
                }}
              >
                Enter to send · Shift+Enter for newline
              </div>
            )}
          </motion.form>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const AgentTilePane = memo(AgentTilePaneBase);
