'use client';

/**
 * Agent cards — a dispatched worker as a canvas object (Canvas voice/multi-agent
 * spec, 2026-06-19). When voice/canvas spawns agents ("spawn two agents on the
 * auth refactor") they bloom here as glass cards, each bound to a live lane.
 *
 * v2 (2026-07-07) — the card is now REAL, IDE-grade: a live transcript tail you
 * can read (assistant text + compact tool-call lines, streaming as the worker
 * works) and a composer you can talk to (steer-packet). The phase stays HONEST —
 * the same `phaseFor` read the DispatchDock uses (working = the o8 binary orbit,
 * no fabricated %) — and a review-ready lane still surfaces its diff on the card.
 *
 * Default is the FULL card (~420×280): header (codename · task · phase · live
 * elapsed) over the transcript over the composer. A header affordance collapses
 * it to the COMPACT status tile (the old 280×92). Chrome routes through the
 * locked CHROME vocabulary via GlassCardShell — never hand-rolled.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { FONT, scrollFadeY } from './ui';
import { GlassCardShell, ShellAction } from './card-shell';
import { runtimeColor } from '@/lib/agents/codename';
import { PhaseRing, phaseFor, type DispatchLane } from './dispatch-dock';
import { useAgentTranscript } from './use-agent-transcript';

/** Compact-mode floor (the old status tile). */
export const AGENT_MIN_W = 240;
export const AGENT_MIN_H = 76;
/** Full-mode floor — room for a readable transcript + the composer. */
export const AGENT_FULL_MIN_W = 340;
export const AGENT_FULL_MIN_H = 200;

/** Bloom presets (page.tsx spawns at FULL). */
export const AGENT_FULL_W = 420;
export const AGENT_FULL_H = 280;
export const AGENT_COMPACT_W = 280;
export const AGENT_COMPACT_H = 92;

export interface AgentCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** The lane this card tracks — the live phase/status is looked up by this id. */
  laneId: string;
  /** Packet id (snapshotted at bloom) — the transcript + steer address. Null
   *  until a lane resolves its packet; the live lane backfills it. */
  packetId: string | null;
  /** Session key (snapshotted at bloom) — the transcript fallback when the
   *  packetId can't be resolved (MCP-dispatched lanes, #1389). */
  sessionKey: string | null;
  /** Repo path (snapshotted at bloom) — meta + a stable key once the lane leaves
   *  the active set. */
  repoPath: string | null;
  /** Lane start (ISO, snapshotted at bloom) — the elapsed timer's origin. */
  startedAt: string | null;
  /** FULL (transcript + composer) vs COMPACT (status tile). Default FULL. */
  expanded: boolean;
  /** Stable address number (#1, #2…) — what voice "agent two" resolves to. */
  number: number;
  /** Memorable, voice-friendly name (Atlas, Nova…) — the primary identity the
   *  operator sees and addresses. Deterministic on laneId (see codename.ts). */
  codename: string;
  /** Snapshotted at bloom so the label survives the lane leaving the active set. */
  title: string;
  /** Worker runtime label (codex / claude-code / …), snapshotted at bloom. */
  runtime: string | null;
  /** True when this card came from a Symon voice-triggered spawn. */
  symonOrigin?: boolean;
}

type SentState = 'sending' | 'sent' | 'unsteerable' | 'failed';
interface SentMessage { id: number; text: string; state: SentState; }

const reviewButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--cnv-ink-muted)',
  background: 'rgba(255,255,255,0.1)',
  borderRadius: 999,
  paddingTop: 4,
  paddingBottom: 4,
  paddingLeft: 13,
  paddingRight: 11,
  fontSize: 10.5,
  fontWeight: 500,
  color: 'var(--cnv-ink)',
  cursor: 'pointer',
  fontFamily: FONT,
};

/** SQLite `datetime('now')` writes bare-UTC "YYYY-MM-DD HH:MM:SS"; ISO paths write
 *  "…Z". Parse both — treat the bare form as UTC (else WebKit reads it local and
 *  the elapsed is hours off). Returns null on anything unparseable so a wrong
 *  clock never renders (honest-over-fabricated). */
function parseStartMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const ms = Date.parse(bare);
  return Number.isFinite(ms) ? ms : null;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Live-ticking elapsed since lane start. Ticks each second while the lane is
 *  live (working/finalizing); freezes at the last value once it settles. */
function useElapsed(startedAt: string | null, live: boolean): string | null {
  const startMs = useMemo(() => parseStartMs(startedAt), [startedAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startMs === null) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, startMs]);
  if (startMs === null) return null;
  return formatElapsed(now - startMs);
}

function LogLine({ kind, text }: { kind: 'assistant' | 'tool' | 'error'; text: string }) {
  if (kind === 'assistant') {
    return (
      <div style={{ fontSize: 11.5, fontWeight: 300, lineHeight: 1.45, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text}
      </div>
    );
  }
  const isError = kind === 'error';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 10.5, fontWeight: 300, lineHeight: 1.4, letterSpacing: '-0.1px', color: isError ? '#f87171' : 'var(--cnv-ink-muted)' }}>
      <span aria-hidden style={{ flexShrink: 0, opacity: 0.7 }}>{isError ? '!' : '›'}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </div>
  );
}

function SentLine({ message }: { message: SentMessage }) {
  const note = message.state === 'unsteerable'
    ? "worker isn't steerable right now"
    : message.state === 'failed'
      ? "couldn't send — try again"
      : message.state === 'sending'
        ? 'sending…'
        : null;
  const noteColor = message.state === 'failed' ? '#f87171' : message.state === 'unsteerable' ? '#f59e0b' : 'var(--cnv-ink-muted)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <div style={{ maxWidth: '86%', paddingTop: 4, paddingBottom: 4, paddingLeft: 9, paddingRight: 9, borderRadius: 10, background: 'var(--cnv-tint-deep)', fontSize: 11.5, fontWeight: 300, lineHeight: 1.4, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: message.state === 'sending' ? 0.7 : 1 }}>
        {message.text}
      </div>
      {note ? (
        <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '-0.1px', color: noteColor, fontFamily: FONT }}>{note}</span>
      ) : null}
    </div>
  );
}

export function AgentGlassCard({
  card,
  lane,
  onMove,
  onResize,
  onFocus,
  onClose,
  onReview,
  onToggleExpand,
}: {
  card: AgentCard;
  /** The live lane row (from activeLanes) — null once the lane settles/leaves. */
  lane: DispatchLane | null;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Open this lane's review diff card. */
  onReview: (laneId: string) => void;
  /** Toggle compact ↔ full (page owns the card geometry). */
  onToggleExpand: (id: number) => void;
}) {
  // A lane that has left the active set has wrapped up — read it as done so the
  // card settles to a check rather than spinning forever.
  const phase = phaseFor(lane ? lane.status : 'done');
  const live = phase.key === 'working' || phase.key === 'finalizing';
  const accent = runtimeColor(card.runtime);

  // Prefer the live lane's ids (a lane can resolve its packet AFTER bloom); fall
  // back to the bloom snapshot so the card keeps working once the lane settles.
  const packetId = lane?.packetId ?? card.packetId ?? null;
  const repoTail = (lane?.repoPath ?? card.repoPath)?.split('/').filter(Boolean).pop() ?? null;
  const meta = [`#${card.number}`, card.runtime, repoTail].filter(Boolean).join(' · ');
  const elapsed = useElapsed(card.startedAt, live);

  const transcript = useAgentTranscript({
    packetId,
    sessionKey: card.sessionKey,
    live,
    enabled: card.expanded,
  });

  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<SentMessage[]>([]);
  const sentIdRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // Auto-scroll to bottom as the worker streams — but only when the operator is
  // already parked at the bottom, so a manual scroll-up to read history holds.
  useEffect(() => {
    if (!card.expanded) return;
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [transcript.lines, sent, card.expanded]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  };

  const submitSteer = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    stickRef.current = true;
    const id = sentIdRef.current;
    sentIdRef.current += 1;
    const patch = (state: SentState) => setSent((prev) => prev.map((m) => (m.id === id ? { ...m, state } : m)));
    setSent((prev) => [...prev, { id, text, state: 'sending' }]);
    if (!packetId) { patch('unsteerable'); return; }
    fetch('/api/orchestrator/steer-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packetId, message: text }),
    })
      .then((response) => {
        if (response.ok) patch('sent');
        else if (response.status === 409) patch('unsteerable');
        else patch('failed');
      })
      .catch(() => patch('failed'));
  };

  const expandAction = (
    <ShellAction label={card.expanded ? 'Collapse agent card' : 'Expand agent card'} onClick={() => onToggleExpand(card.id)}>
      {card.expanded ? (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 9 4 4m0 5V4h5M15 15l5 5m0-5v5h-5" />
        </svg>
      ) : (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 14v5h5m11-9V5h-5M9 19 4 14M20 5l-5 5" />
        </svg>
      )}
    </ShellAction>
  );

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={card.expanded ? AGENT_FULL_MIN_W : AGENT_MIN_W}
      minH={card.expanded ? AGENT_FULL_MIN_H : AGENT_MIN_H}
      title={card.codename || `Agent ${card.number}`}
      badge={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: 3, background: phase.color, flexShrink: 0 }} />
          {elapsed ?? phase.label}
        </span>
      }
      actions={expandAction}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
      {card.expanded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, height: card.h, overflow: 'hidden' }}>
          {/* Phase + task — the role label voice addresses ("the auth agent"). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
            <span style={{ display: 'inline-flex', width: 16, height: 16, flexShrink: 0 }}>
              <PhaseRing phase={phase} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 400, letterSpacing: '-0.15px', color: phase.key === 'blocked' || phase.key === 'error' ? phase.color : 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {card.title}
              </div>
              {meta ? (
                <div style={{ marginTop: 1, fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
                  {meta}
                </div>
              ) : null}
            </div>
            {phase.handoff ? (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onReview(card.laneId)}
                aria-label={`Review ${card.codename || `agent ${card.number}`}`}
                style={{ ...reviewButton, flexShrink: 0, paddingTop: 3, paddingBottom: 3, paddingLeft: 10, paddingRight: 9, fontSize: 10 }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
              >
                Review
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}>
                  <path d="M7 17 17 7M8 7h9v9" />
                </svg>
              </button>
            ) : null}
          </div>

          {/* Live transcript tail — assistant text + compact tool lines, streaming. */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            onPointerDown={(event) => event.stopPropagation()}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 7, paddingRight: 4, ...scrollFadeY }}
          >
            {transcript.lines.length === 0 && sent.length === 0 ? (
              <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', paddingTop: 6 }}>
                {transcript.status === 'loading'
                  ? 'Reading transcript…'
                  : transcript.status === 'unavailable'
                    ? 'No transcript for this runtime yet.'
                    : live ? 'Waiting for the first output…' : 'No transcript.'}
              </div>
            ) : (
              <>
                {transcript.lines.map((line) => <LogLine key={line.seq} kind={line.kind} text={line.text} />)}
                {sent.map((message) => <SentLine key={`s-${message.id}`} message={message} />)}
              </>
            )}
          </div>

          {/* Composer — talk to this agent (steer-packet). */}
          <form
            onSubmit={submitSteer}
            onPointerDown={(event) => event.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingTop: 2 }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { event.stopPropagation(); }}
              placeholder="Message this agent…"
              aria-label="Message this agent"
              style={{
                flex: 1,
                minWidth: 0,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--cnv-edge)',
                background: 'var(--cnv-tint)',
                borderRadius: 999,
                paddingTop: 5,
                paddingBottom: 5,
                paddingLeft: 11,
                paddingRight: 11,
                fontSize: 11.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: 'var(--cnv-ink)',
                fontFamily: FONT,
                outline: 'none',
              }}
            />
            <button
              type="submit"
              aria-label="Send message to agent"
              disabled={!draft.trim()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                flexShrink: 0,
                borderWidth: 0,
                borderRadius: '50%',
                background: draft.trim() ? accent : 'var(--cnv-tint-deep)',
                color: draft.trim() ? '#fff' : 'var(--cnv-ink-muted)',
                cursor: draft.trim() ? 'pointer' : 'default',
                transition: 'background 140ms ease',
              }}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}>
                <path d="M7 11 12 6l5 5M12 6v12" />
              </svg>
            </button>
          </form>
        </div>
      ) : (
        /* COMPACT — the status tile (the pre-v2 card). */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, height: card.h, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ display: 'inline-flex', width: 16, height: 16, flexShrink: 0 }}>
              <PhaseRing phase={phase} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 400, letterSpacing: '-0.15px', color: phase.key === 'blocked' || phase.key === 'error' ? phase.color : 'var(--cnv-ink)', fontFamily: FONT }}>
              {phase.label}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {card.title}
            </div>
            {meta ? (
              <div style={{ marginTop: 2, fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
                {meta}
              </div>
            ) : null}
          </div>
          {phase.handoff ? (
            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center' }}>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onReview(card.laneId)}
                aria-label={`Review ${card.codename || `agent ${card.number}`}`}
                style={reviewButton}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
              >
                Review
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}>
                  <path d="M7 17 17 7M8 7h9v9" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      )}
    </GlassCardShell>
  );
}
