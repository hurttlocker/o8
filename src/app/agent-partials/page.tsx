'use client';

/**
 * /agent-partials — the OUTSIDE-THE-WINDOW live agent-transcription HUD.
 *
 * This route is the body of a THIRD always-on-top, transparent, fully
 * click-through Tauri window labeled `agent-partials` (NEVER `main` — see the
 * label-discipline note in `src-tauri/src/agent_partials_window.rs`). The Rust
 * side creates that window after the bundled Next server is up, anchors it
 * bottom-center on the monitor the main o8 window sits on, and applies the
 * transparent / level-25 / nonactivating / ignore-cursor-events recipe. This
 * page only has to:
 *
 *   1. Subscribe to the broadcast `o8:stt-event` (Rust `app.emit`, which reaches
 *      every window). Same payload shape as `useNativeDictation` / the dock.
 *   2. LATCH on an AGENT-lane session only: the ONLY event that carries
 *      `lane: 'agent'` at the start is `system-start` (fn_hotkey.rs). Later
 *      `partial` / `final` / `level` events are just `origin: 'system'` with NO
 *      lane, so we latch agent-ness from that start until a terminal event
 *      (`system-idle` / `error` / `system-pasted`) tears it down. A plain Fn
 *      dictation emits `system-start` with NO lane, so it NEVER latches → this
 *      HUD can never show for Fn dictation. Copied from `symon-voice-presence`.
 *   3. Render the big black partials bar — the visual language of the in-canvas
 *      SymonVoicePresencePill scaled up so it reads across a room. The in-canvas
 *      pill's listening/partial rendering is suppressed while this surface owns
 *      it (see the comment in `symon-voice-presence.tsx`).
 *
 * The window is ALWAYS-ON; visibility is controlled HERE by rendering nothing
 * (the window is transparent, so nothing rendered = invisible) unless an
 * agent-lane dictation is live.
 *
 * Inline styles only (repo rule). This is a floating black HUD, intentionally
 * palette-independent (like the dock), so raw dark rgba is acceptable here.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { isTauri } from '@/lib/tauri/bridge';

export const dynamic = 'force-dynamic';

// System font stack (hurttlocker: never webfont-locked). SF Pro renders the
// light weights as true thins on macOS, where this HUD lives.
const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif';

// Terminal STT types that ALWAYS tear the HUD down, regardless of lane — this is
// what guarantees a no-lane `error` mid-session still clears the latch. NOT
// `complete` / `ready`: those recognizer-teardown signals can arrive between
// `final` and the agent's `polished`, and treating them as terminal would kill
// the bar early.
const TERMINAL = new Set(['system-idle', 'error', 'system-pasted']);

// Keep the last text visible for a beat before the exit fade, so the final /
// polished command reads "briefly" (the agent flow emits system-idle right after
// polished, so without this hold the final text would never be seen).
const DISMISS_DELAY_MS = 600;
// Defensive auto-clear if a terminal event is somehow missed — never strand a
// black bar on screen.
const SAFETY_MS = 60_000;
/** Delay before the FIRST paint of a session — gives an in-canvas surface claim
 *  time to land so the HUD never flashes over a composer that owns the partials. */
const PAINT_GRACE_MS = 300;

type Phase = 'listening' | 'final';

interface SttPayload {
  type?: string;
  origin?: string;
  lane?: string;
  text?: string;
  // Plain Fn dictation carries no lane, but when the operator has opted into the
  // Fn partials HUD (`fn_hud_partials`), the Rust side tags its `system-start`
  // with `hud: true` so this page latches for the Fn path too. Default OFF —
  // absent means the HUD stays invisible during Fn dictation, as before.
  hud?: boolean;
}

interface HudState {
  phase: Phase;
  text: string;
}

export default function AgentPartialsPage() {
  const prefersReducedMotion = useReducedMotion();
  const [state, setState] = useState<HudState | null>(null);
  // While the in-canvas composer owns the partials (Right-Option dictation with
  // o8 focused + the canvas visible), it claims the surface via
  // `o8:agent-partials-claim` and THIS HUD stops painting — single-surface rule,
  // no doubles. Tied to a session id; auto-expires on release or the 60s safety.
  const [suppressed, setSuppressed] = useState(false);
  const [graceElapsed, setGraceElapsed] = useState(false);
  // Session-elapsed seconds — the honest "still recording" signal on long
  // holds (operator ask 2026-07-13: a long dictation gave no cue the capture
  // was alive). Rendered in the header from 10s so quick dictations stay clean.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const sessionStartedAtRef = useRef<number | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claimSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentActiveRef = useRef(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The window is transparent at the OS level; the page html/body must NOT paint
  // a background or the window shows a solid rectangle instead of just the bar.
  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const clearDismiss = () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
    const clearSafety = () => {
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
    const teardown = () => {
      agentActiveRef.current = false;
      clearSafety();
      clearDismiss();
      // Hold the last text a beat, then unmount → exit animation plays.
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        setState(null);
      }, DISMISS_DELAY_MS);
    };
    const activate = () => {
      agentActiveRef.current = true;
      clearDismiss();
      clearSafety();
      safetyTimerRef.current = setTimeout(teardown, SAFETY_MS);
      // PAINT GRACE (2026-07-08 live-hit): the canvas composer's surface CLAIM
      // races this system-start — both fan out from the same keypress, and the
      // claim can land a beat late (or get missed by the broadcast entirely; a
      // Rust relay now also forwards it directly). Hold the first paint ~300ms
      // so a claiming canvas means this HUD never flashes an empty bar over it.
      setGraceElapsed(false);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        setGraceElapsed(true);
      }, PAINT_GRACE_MS);
      sessionStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setState({ phase: 'listening', text: '' });
    };
    const showText = (phase: Phase, text: string) => {
      // A new frame of live text — keep the HUD alive (cancel any pending fade)
      // AND re-arm the stranded-bar safety. The safety exists for a missed
      // terminal event; a live frame is proof the session is NOT stranded.
      // Without this re-arm the HUD tore itself down at exactly SAFETY_MS into
      // a long dictation while the operator was still speaking (live-hit
      // 2026-07-13: "the partials just left and I'm still talking").
      clearDismiss();
      clearSafety();
      safetyTimerRef.current = setTimeout(teardown, SAFETY_MS);
      setState({ phase, text });
    };

    const handle = (p: SttPayload) => {
      const type = p.type;
      // System-origin only (`system-pasted` is system by construction, even if
      // the origin field is absent on some emit paths).
      if (p.origin !== 'system' && type !== 'system-pasted') return;

      // Activate on an AGENT-lane system-start (Right-Option Symon agent) OR a
      // plain Fn system-start explicitly tagged `hud: true` (the opt-in Fn
      // partials HUD, `fn_hud_partials`). A plain Fn system-start with neither
      // is ignored → Fn dictation stays invisible unless the operator opted in.
      if (type === 'system-start') {
        if (p.lane === 'agent' || p.hud === true) activate();
        return;
      }

      // Terminal events ALWAYS tear down, regardless of lane — a no-lane `error`
      // mid-session still clears the latch here.
      if (TERMINAL.has(type ?? '')) {
        teardown();
        return;
      }

      // Everything else requires the agent latch (or an explicit `lane: agent`
      // on the event itself, e.g. `polished`). Fn partials carry no lane and
      // never latch, so they fall through here.
      if (!agentActiveRef.current && p.lane !== 'agent') return;

      const text = (p.text ?? '').trim();
      switch (type) {
        case 'partial':
          showText('listening', text);
          break;
        case 'final':
          if (text) showText('final', text);
          break;
        case 'polished':
          // Agent-mode polished command. Show it, then fade — the agent flow
          // emits `system-idle` immediately after, and the fade delay keeps the
          // command readable for a beat either way.
          if (text) showText('final', text);
          teardown();
          break;
        default:
          break;
      }
    };

    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<SttPayload>('o8:stt-event', (e) => handle(e.payload ?? {})))
      .then((un) => {
        if (disposed) {
          un();
          return;
        }
        unlisten = un;
      })
      .catch(() => {
        /* noop — a HUD that can't subscribe simply never paints */
      });

    return () => {
      disposed = true;
      clearDismiss();
      clearSafety();
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* noop */
        }
        unlisten = null;
      }
    };
  }, []);

  // HUD-yield protocol — listen for the in-canvas composer's surface claim. When
  // claimed, suppress our paint (the composer streams the partials in place); on
  // release, resume. Safety: a dead canvas that never sends `claimed: false`
  // still frees the HUD after SAFETY_MS, so we can never stay dark forever.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const clearClaimSafety = () => {
      if (claimSafetyRef.current) {
        clearTimeout(claimSafetyRef.current);
        claimSafetyRef.current = null;
      }
    };
    const handleClaim = (p: { claimed?: boolean }) => {
      if (p.claimed) {
        setSuppressed(true);
        clearClaimSafety();
        claimSafetyRef.current = setTimeout(() => {
          claimSafetyRef.current = null;
          setSuppressed(false);
        }, SAFETY_MS);
      } else {
        clearClaimSafety();
        setSuppressed(false);
      }
    };

    // Two channels, one handler: the canvas's own broadcast AND the Rust
    // relay's forward. The relay MUST use a DIFFERENT event name — its
    // listen_any hears every emit including its own emit_to, so relaying under
    // the original name recursed Rust-side until the thread's stack blew
    // (2026-07-09 crash, EXC_BAD_ACCESS stack_overflow on tokio-rt-worker).
    let unlistenFwd: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const direct = await listen<{ claimed?: boolean; sessionId?: string }>(
          'o8:agent-partials-claim',
          (e) => handleClaim(e.payload ?? {}),
        );
        const fwd = await listen<{ claimed?: boolean; sessionId?: string }>(
          'o8:agent-partials-claim-fwd',
          (e) => handleClaim(e.payload ?? {}),
        );
        if (disposed) {
          direct();
          fwd();
          return;
        }
        unlisten = direct;
        unlistenFwd = fwd;
      })
      .catch(() => {
        /* noop — no claim bridge simply means the HUD never yields */
      });

    return () => {
      disposed = true;
      clearClaimSafety();
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* noop */
        }
      }
      if (unlistenFwd) {
        try {
          unlistenFwd();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  // Pin the transcript to the bottom so the NEWEST words are always visible; the
  // top fades out via the mask. Runs after each text change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.text]);

  // Tick the elapsed counter once a second while listening.
  useEffect(() => {
    if (!state || state.phase !== 'listening') return undefined;
    const tick = () => {
      const startedAt = sessionStartedAtRef.current;
      if (startedAt) setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [state?.phase, state]);

  const display = state
    ? state.text || (state.phase === 'listening' ? 'Listening' : '')
    : '';
  const rise = prefersReducedMotion ? 0 : 4;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingLeft: 24,
        paddingRight: 24,
        paddingBottom: 6,
        boxSizing: 'border-box',
        background: 'transparent',
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {state && !suppressed && graceElapsed ? (
          <motion.div
            key="agent-partials-bar"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: rise }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: rise }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              width: 'min(680px, calc(100vw - 56px))',
              maxWidth: '100%',
              boxSizing: 'border-box',
              paddingTop: 16,
              paddingBottom: 16,
              paddingLeft: 26,
              paddingRight: 26,
              borderRadius: 22,
              background: 'rgba(9, 10, 13, 0.82)',
              backdropFilter: 'blur(22px) saturate(140%)',
              WebkitBackdropFilter: 'blur(22px) saturate(140%)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(255, 255, 255, 0.12)',
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4)',
              fontFamily: FONT,
              pointerEvents: 'none',
            } as React.CSSProperties}
          >
            {/* Compact header — a soft "Listening" tier label + a status dot.
                Kept thin + faint so the transcript is the star. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: '#34d399',
                  boxShadow: '0 0 8px rgba(52, 211, 153, 0.7)',
                  flexShrink: 0,
                  animation: prefersReducedMotion
                    ? undefined
                    : 'o8PartialsPulse 1.6s ease-in-out infinite',
                }}
              />
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 300,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'rgba(255, 255, 255, 0.55)',
                  lineHeight: 1,
                }}
              >
                Symon · Listening
              </span>
              {state.phase === 'listening' && elapsedSeconds >= 10 ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 10,
                    fontWeight: 300,
                    letterSpacing: '0.04em',
                    color: 'rgba(255, 255, 255, 0.45)',
                    lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {`${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`}
                </span>
              ) : null}
            </div>

            {/* The partials transcript — big + room-readable. Bottom-anchored so
                the newest words are always visible; older lines clip + fade at
                the top (max ~3 lines). Weight bumped to 400 for legibility on the
                dark HUD (hurttlocker eye-ergonomics lens: legibility over spec). */}
            <div
              ref={scrollRef}
              style={{
                maxHeight: 84,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 26px)',
                maskImage: 'linear-gradient(to bottom, transparent 0px, black 26px)',
              } as React.CSSProperties}
            >
              <span
                style={{
                  fontSize: 19,
                  fontWeight: 400,
                  letterSpacing: '-0.1px',
                  lineHeight: 1.4,
                  color: state.text
                    ? 'rgba(255, 255, 255, 0.97)'
                    : 'rgba(255, 255, 255, 0.62)',
                  textShadow: '0 1px 10px rgba(0, 0, 0, 0.55)',
                  overflowWrap: 'anywhere',
                }}
              >
                {display}
              </span>
            </div>
            <style>
              {'@keyframes o8PartialsPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }'}
            </style>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
