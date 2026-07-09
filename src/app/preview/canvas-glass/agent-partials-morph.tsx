'use client';

/**
 * agent-partials-morph — the in-canvas COMPOSER morph for Right-Option (agent
 * lane) dictation.
 *
 * When the canvas is up + visible + focused and an agent-lane dictation starts,
 * the bottom orchestrator composer swaps its controls out and streams the live
 * partial words IN PLACE — reusing the composer's own pill geometry so the
 * words land exactly where the operator expects to type. It mirrors the black
 * outside-the-window HUD (`src/app/agent-partials/page.tsx`): the same agent
 * latch, the same bottom-anchored transcript that GROWS up to ~3 lines with the
 * newest words visible and older text fading at the top edge.
 *
 * Single-surface rule: while the canvas owns the partials it EMITS a Tauri
 * `o8:agent-partials-claim` event so the outside HUD suppresses its own paint —
 * no doubles. The claim is tied to a session id and released on teardown (and
 * self-heals via the HUD's own terminal-event + 60s safety nets).
 *
 * Inline styles only (repo rule); canvas tokens (`--cnv-*`) so it tracks the
 * glass palette. See `useAgentPartialsMorph` for the latch + claim protocol and
 * `ComposerPartialsFill` for the growing transcript.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { FONT } from './ui';

export type MorphPhase = 'listening' | 'final';

export interface AgentPartialsMorphState {
  /** Fill mounted + controls hidden — true from activate through the close animation. */
  active: boolean;
  /** Collapse + fade-back in progress (the composer returns to its 1-line geometry). */
  closing: boolean;
  phase: MorphPhase;
  text: string;
}

const IDLE: AgentPartialsMorphState = { active: false, closing: false, phase: 'listening', text: '' };

// Terminal STT types that END the session — mirror the outside HUD so a no-lane
// `error` mid-session still tears the morph down.
const TERMINAL = new Set(['system-idle', 'error', 'system-pasted']);
// Keep the final/polished command a beat before collapsing (mirrors the HUD's
// DISMISS_DELAY_MS so the command reads either way).
const HOLD_MS = 600;
// Collapse + fade-back window.
const CLOSE_MS = 240;
// Defensive auto-clear if a terminal event is somehow missed — never strand the
// morph (or leave the HUD suppressed) forever.
const SAFETY_MS = 60_000;

// Transcript geometry — a compact echo of the HUD (which caps at ~3 lines and
// then scrolls, newest at the bottom). 13px composer text at lineHeight 1.4.
export const MORPH_LINE_H = 18;
export const MORPH_MAX_LINES = 3;

interface SttPayload {
  type?: string;
  origin?: string;
  lane?: string;
  text?: string;
}

/**
 * Latch onto an agent-lane dictation and drive the composer morph + HUD claim.
 * `canClaim` is polled at system-start (must return true only when the canvas
 * composer is genuinely on screen + the window is focused) — if it's false we
 * neither morph nor claim, so the outside HUD paints normally.
 */
export function useAgentPartialsMorph(canClaim: () => boolean): AgentPartialsMorphState {
  const [state, setState] = useState<AgentPartialsMorphState>(IDLE);
  const canClaimRef = useRef(canClaim);
  canClaimRef.current = canClaim;
  const sessionRef = useRef<string | null>(null);
  const releasedRef = useRef(true);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let emit: ((event: string, payload?: unknown) => Promise<unknown>) | null = null;

    const clearTimer = (r: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
      if (r.current) { clearTimeout(r.current); r.current = null; }
    };
    const clearAllTimers = () => { clearTimer(holdRef); clearTimer(closeRef); clearTimer(safetyRef); };

    const releaseClaim = () => {
      const sid = sessionRef.current;
      if (sid && !releasedRef.current && emit) {
        releasedRef.current = true;
        void emit('o8:agent-partials-claim', { claimed: false, sessionId: sid });
      }
    };

    const beginClose = () => {
      if (closeRef.current) return;
      setState((s) => (s.active ? { ...s, closing: true } : s));
      closeRef.current = setTimeout(() => {
        closeRef.current = null;
        // Release the HUD only once the composer has FULLY faded back — the
        // outside HUD must stay suppressed for the whole hold+collapse window,
        // or the final command would double (composer AND HUD) at session end.
        releaseClaim();
        sessionRef.current = null;
        setState(IDLE);
      }, CLOSE_MS);
    };

    // A session-ending event landed: run the visual hold → collapse so the last
    // command stays readable for a beat; the claim is released when that
    // completes (see beginClose).
    const endSession = () => {
      if (!sessionRef.current) return;
      clearTimer(safetyRef);
      if (holdRef.current || closeRef.current) return;
      holdRef.current = setTimeout(() => { holdRef.current = null; beginClose(); }, HOLD_MS);
    };

    const activate = (sid: string) => {
      clearAllTimers();
      sessionRef.current = sid;
      releasedRef.current = false;
      setState({ active: true, closing: false, phase: 'listening', text: '' });
      if (emit) void emit('o8:agent-partials-claim', { claimed: true, sessionId: sid });
      safetyRef.current = setTimeout(endSession, SAFETY_MS);
    };

    const handle = (p: SttPayload) => {
      const type = p.type;
      if (p.origin !== 'system' && type !== 'system-pasted') return;

      if (type === 'system-start') {
        // Only an AGENT-lane start latches, and only when the canvas is the
        // live surface — otherwise the outside HUD keeps ownership.
        if (p.lane === 'agent' && canClaimRef.current()) {
          activate(`morph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        }
        return;
      }

      if (TERMINAL.has(type ?? '')) { endSession(); return; }

      // Only paint frames for a session WE claimed.
      if (!sessionRef.current) return;
      const text = (p.text ?? '').trim();
      switch (type) {
        case 'partial':
          setState((s) => (s.active && !s.closing ? { ...s, phase: 'listening', text } : s));
          break;
        case 'final':
          if (text) setState((s) => (s.active && !s.closing ? { ...s, phase: 'final', text } : s));
          break;
        case 'polished':
          if (text) setState((s) => (s.active && !s.closing ? { ...s, phase: 'final', text } : s));
          endSession();
          break;
        default:
          break;
      }
    };

    import('@tauri-apps/api/event')
      .then((mod) => {
        emit = mod.emit;
        return mod.listen<SttPayload>('o8:stt-event', (e) => handle(e.payload ?? {}));
      })
      .then((un) => { if (disposed) un(); else unlisten = un; })
      .catch(() => { /* no Tauri event bridge → morph simply never activates */ });

    return () => {
      disposed = true;
      // Never strand the HUD if the canvas unmounts mid-session.
      releaseClaim();
      clearAllTimers();
      if (unlisten) { try { unlisten(); } catch { /* noop */ } }
    };
  }, []);

  return state;
}

/**
 * The transcript that replaces the composer's controls while morphed. In-flow
 * (drives the pill's height) so the pill GROWS upward as the utterance runs —
 * the composer is bottom-anchored, so the bottom edge stays put and the words
 * climb, exactly like the outside HUD. Bottom-anchored + top fade mask keeps the
 * newest words visible; caps at ~3 lines then scrolls. `closing` collapses it
 * back to one line + fades out. `reduce` = prefers-reduced-motion (instant).
 */
export function ComposerPartialsFill({
  phase,
  text,
  closing,
  reduce,
}: {
  phase: MorphPhase;
  text: string;
  closing: boolean;
  reduce: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [contentH, setContentH] = useState(MORPH_LINE_H);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // pin the newest words to the bottom
    setContentH(Math.min(el.scrollHeight, MORPH_LINE_H * MORPH_MAX_LINES));
  }, [text]);

  const display = text || (phase === 'listening' ? 'Listening' : '');
  const targetH = closing ? MORPH_LINE_H : Math.max(MORPH_LINE_H, contentH);

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        opacity: closing ? 0 : 1,
        transition: reduce ? undefined : 'opacity 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          flexShrink: 0,
          marginBottom: 5,
          background: phase === 'final' ? 'var(--t-accent, var(--cnv-ink))' : 'var(--cnv-ink)',
          animation: reduce ? undefined : 'o8MorphPulse 1.6s ease-in-out infinite',
        }}
      />
      <div
        ref={scrollRef}
        role="status"
        aria-live="polite"
        style={{
          flex: 1,
          minWidth: 0,
          height: targetH,
          maxHeight: MORPH_LINE_H * MORPH_MAX_LINES,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          transition: reduce ? undefined : 'height 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 16px)',
          maskImage: 'linear-gradient(to bottom, transparent 0px, black 16px)',
        } as React.CSSProperties}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: `${MORPH_LINE_H}px`,
            color: 'var(--cnv-ink)',
            overflowWrap: 'anywhere',
            fontFamily: FONT,
          }}
        >
          {display}
        </span>
      </div>
      <style>{'@keyframes o8MorphPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }'}</style>
    </div>
  );
}
