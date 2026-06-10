'use client';

/**
 * /dictation-pill — the SCREEN-LEVEL dock pill (system-wide Symon fold P3).
 *
 * This route is the body of a SECOND, always-on-top, transparent Tauri window
 * labeled `dock` (NEVER `main` — see the label-discipline note in
 * `docs/symon-systemwide-fold.md`). The Rust side creates that window after the
 * bundled Next server is confirmed up, navigates it here, and applies the
 * top-center / level-25 / clearColor / nonactivating recipe. This page only
 * has to:
 *
 *   1. Subscribe to `o8:stt-event` (same payload shape as `useNativeDictation`)
 *      and reduce it into a `DictationSnapshot`.
 *   2. Filter to SYSTEM-origin sessions only (`origin === 'system'`), so the
 *      global-Fn pill never mirrors an in-window mic session and vice-versa.
 *      The broadcast `o8:stt-event` reaches BOTH windows — the discriminator is
 *      what keeps them from double-rendering.
 *   3. Render the ONE morphing notch pill via `DockNotchSurface` — a faithful
 *      port of Symon's NotchSurface: a SINGLE element that morphs in place
 *      (idle sliver ⇄ listening capsule ⇄ thinking squiggle ⇄ done flash),
 *      CENTERED in the window (the WINDOW provides the position — no
 *      `createPortal`, no fixed-bottom anchor). This is distinct from the
 *      in-window floating pill (`DictationPill`), which is UNCHANGED.
 *
 * The dock window is ALWAYS-ON: Rust creates it visible at boot and never hides
 * it on the normal flow. This route therefore ALWAYS paints — at minimum the
 * compact Symon idle sliver — and MORPHS idle → recording (`system-start`) →
 * polishing → success → idle, all on the SAME element. A discarded Fn brush or
 * a start error emits `system-idle` to morph back to the idle sliver.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { DockNotchSurface } from '@/components/desktop/dictation/DockNotchSurface';
import { useDockFileDrop, type StagedChip } from '@/components/desktop/dictation/useDockFileDrop';
import type { AskTurn } from '@/components/desktop/dictation/DockAskPanel';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';

export const dynamic = 'force-dynamic';

/**
 * Dock-route morph instrumentation. This route runs in a SECOND webview whose
 * `console.log` does NOT reach `~/Library/Logs/ai.o8.desktop/o8.log`, so when
 * the dock fails to morph there is no server trace to inspect. `o8_dock_log`
 * (a thin Tauri command → `tracing::info!("[dock-route] …")`) lets us SEE which
 * `o8:stt-event` payloads actually arrive at the dock webview. Fire-and-forget;
 * never throws. Skip the high-frequency partial/level events at the call site.
 */
function dockLog(msg: string) {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('o8_dock_log', { msg }))
    .catch(() => { /* noop — never let logging break the morph */ });
}

/** Fire a Tauri command from the dock webview (TTS controls, dock resize).
 * Fire-and-forget; never throws (the dock must never crash on a control tap). */
function invokeCmd(cmd: string, args?: Record<string, unknown>) {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke(cmd, args))
    .catch((err) => dockLog(`invoke ${cmd} failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** TTS playback state mirrored from the native engine via `o8:tts-state`. */
type TtsControlState = 'idle' | 'playing' | 'paused';

/** Ask answer panel (voice P4 C3). */
type AskMode = 'idle' | 'listening' | 'answer';
const ASK_IDLE_COLLAPSE_MS = 45_000; // auto-collapse the panel after idle
const ASK_RESUME_WINDOW_MS = 60_000; // preserve the thread if reopened within
const ASK_MAX_TURNS = 16; // 8 exchanges before trimming the oldest

const SUCCESS_FLASH_MS = 900;
const ERROR_FLASH_MS = 2500;

const IDLE_SNAPSHOT: DictationSnapshot = {
  state: 'idle',
  audioLevel: 0,
  durationMs: 0,
  error: null,
  partialTranscript: '',
};

interface SttEventPayload {
  type:
    | 'ready'
    | 'system-start'
    | 'system-idle'
    | 'partial'
    | 'final'
    | 'level'
    | 'audio_file'
    | 'status'
    | 'error'
    | 'complete'
    | 'polished'
    | 'system-pasted';
  /** Origin discriminator (system-wide Symon fold P3 review HIGH). Only the
   * dock window reacts to `system`; the in-window pill reacts to the rest. */
  origin?: 'system' | 'in-window';
  /** Lane marker — `agent` on the Option-gesture start, so a dictation that
   * begins mid-conversation can render INSIDE the open panel as a pending
   * chat turn instead of collapsing the panel to the listening capsule. */
  lane?: string;
  sessionId?: number;
  text?: string;
  level?: number;
  chars?: number;
}

/** Pending in-panel dictation (chat continuity): listening → polishing →
 * handoff (final transcript on its way to the agent). */
type PanelPending = { phase: 'listening' | 'polishing' | 'handoff'; text: string };

export default function DictationPillPage() {
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(IDLE_SNAPSHOT);
  const [ttsState, setTtsState] = useState<TtsControlState>('idle');
  const [askOpen, setAskOpen] = useState(false);
  const [askMode, setAskMode] = useState<AskMode>('idle');
  const [askThread, setAskThread] = useState<AskTurn[]>([]);
  // Symon voice agent: a pending confirm card + the working indicator.
  const [agentConfirm, setAgentConfirm] = useState<
    { taskId: string; tool: string; summary: string } | null
  >(null);
  const [agentWorking, setAgentWorking] = useState(false);
  // Current running tool + when the task started — drive the working capsule's
  // "Synthesizing…/Working…" label + live elapsed timer.
  const [agentTool, setAgentTool] = useState<string>('');
  const [agentStartedAt, setAgentStartedAt] = useState<number>(0);
  const askIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askLastClosedRef = useRef<number>(0);
  const askOpenRef = useRef(false);
  const askThreadRef = useRef<AskTurn[]>([]);
  // The intent of the in-flight agent task, captured on `running` so the `done`
  // event can show it as the "You" turn in the shared answer panel.
  const agentIntentRef = useRef<string>('');
  // Last agent task whose terminal (done/failed) event we've handled — guards
  // the dual-emit (emit_to dock + broadcast both reach the dock window) from
  // appending the answer twice.
  const agentDoneRef = useRef<string>('');

  // Chat continuity: an agent-lane dictation that starts while the conversation
  // panel is open renders as a pending turn INSIDE the panel — the dock never
  // collapses to the capsule mid-conversation. Ref mirrors state so the stable
  // stt-event handler can read it without re-subscribing.
  const [panelPending, setPanelPending] = useState<PanelPending | null>(null);
  const panelPendingRef = useRef<PanelPending | null>(null);
  const pendingHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentWorkingRef = useRef(false);
  const updatePanelPending = useCallback((next: PanelPending | null) => {
    panelPendingRef.current = next;
    setPanelPending(next);
  }, []);

  const stateRef = useRef<DictationState>('idle');
  const startTimeRef = useRef<number>(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const setState = useCallback((next: DictationState, patch?: Partial<DictationSnapshot>) => {
    stateRef.current = next;
    setSnapshot((prev) => ({ ...prev, ...patch, state: next }));
  }, []);

  const returnToIdleAfter = useCallback((ms: number) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      stateRef.current = 'idle';
      setSnapshot(IDLE_SNAPSHOT);
    }, ms);
  }, []);

  const beginRecording = useCallback(() => {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    startTimeRef.current = Date.now();
    stateRef.current = 'recording';
    setSnapshot({ state: 'recording', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
  }, []);

  const handleEvent = useCallback((payload: SttEventPayload) => {
    // ── Origin discriminator ──
    // Only react to SYSTEM-origin sessions. `o8:stt-event` is broadcast to all
    // windows; the in-window DictationHost handles `in-window` (and unmarked
    // legacy) sessions. `system-pasted` is system by construction even if the
    // origin field is absent, so we accept it unconditionally.
    if (payload.type !== 'system-pasted' && payload.origin !== 'system') {
      return;
    }

    // Trace the morph path: confirms the dock webview is RECEIVING system events
    // (the prior bug was the broadcast not reaching this second window — now
    // Rust emit_to(DOCK_LABEL, …) targets it directly). This route's
    // `console.log` does NOT reach the server log, so we ALSO write to the Rust
    // tracing log via `o8_dock_log` — that's the only way to SEE in o8.log
    // whether/which events arrive at the dock route. Skip the per-frame
    // `level`/`partial` events so the trace stays brief — the morph-driving
    // events (system-start/idle/pasted, final, audio_file, error) are what
    // matter.
    if (payload.type !== 'level' && payload.type !== 'partial') {
      console.log('[dock-pill] system stt-event', payload.type, '→ state', stateRef.current);
      dockLog(`stt-event ${payload.type} → state ${stateRef.current}`);
    }

    switch (payload.type) {
      case 'system-start':
        // Chat continuity: an AGENT-lane dictation starting while the
        // conversation panel is open (with turns) renders inside the panel as
        // a pending You turn — the panel keeps the dock, no capsule collapse.
        if (payload.lane === 'agent' && askOpenRef.current && askThreadRef.current.length > 0) {
          if (pendingHandoffTimerRef.current) {
            clearTimeout(pendingHandoffTimerRef.current);
            pendingHandoffTimerRef.current = null;
          }
          updatePanelPending({ phase: 'listening', text: '' });
          // Suspend the idle auto-collapse while the user is mid-turn.
          if (askIdleTimerRef.current) {
            clearTimeout(askIdleTimerRef.current);
            askIdleTimerRef.current = null;
          }
        }
        beginRecording();
        break;
      case 'system-idle':
        // Brush discarded / start error / agent finalize teardown — morph the
        // dock back. With a pending in-panel turn this is the HANDOFF moment
        // (polish done, transcript on its way to the agent): hold the pending
        // turn briefly; if no `running` status claims it, it was a discard.
        if (panelPendingRef.current) {
          updatePanelPending({ ...panelPendingRef.current, phase: 'handoff' });
          if (pendingHandoffTimerRef.current) clearTimeout(pendingHandoffTimerRef.current);
          pendingHandoffTimerRef.current = setTimeout(() => {
            pendingHandoffTimerRef.current = null;
            if (panelPendingRef.current?.phase === 'handoff' && !agentWorkingRef.current) {
              updatePanelPending(null);
            }
          }, 5000);
        }
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
          flashTimerRef.current = null;
        }
        stateRef.current = 'idle';
        setSnapshot(IDLE_SNAPSHOT);
        break;
      case 'ready':
        // Fn-down can race the daemon's `ready`; treat it as a start signal if
        // we somehow missed `system-start` (defensive — system-start is primary).
        if (stateRef.current === 'idle') beginRecording();
        break;
      case 'level':
        if (stateRef.current === 'recording' && typeof payload.level === 'number') {
          const level = Math.min(1, payload.level);
          const duration = Date.now() - startTimeRef.current;
          setSnapshot((prev) => (prev.state === 'recording'
            ? { ...prev, audioLevel: level, durationMs: duration }
            : prev));
        }
        break;
      case 'partial':
        if (stateRef.current === 'recording' && typeof payload.text === 'string') {
          if (panelPendingRef.current?.phase === 'listening') {
            updatePanelPending({ phase: 'listening', text: payload.text });
          }
          setSnapshot((prev) => (prev.state === 'recording' && prev.partialTranscript !== payload.text
            ? { ...prev, partialTranscript: payload.text ?? '' }
            : prev));
        }
        break;
      case 'final':
        if (panelPendingRef.current?.phase === 'listening') {
          updatePanelPending({ ...panelPendingRef.current, phase: 'polishing' });
        }
        if (stateRef.current === 'recording') setState('transcribing');
        break;
      case 'audio_file':
        if (stateRef.current === 'transcribing') setState('polishing');
        break;
      case 'system-pasted':
        // Paste landed in the focused app — flash the ACTUAL pasted words in
        // the dock (Symon parity: the notch shows the text, not just "Pasted"),
        // then collapse back to the idle capsule.
        setState('success', { audioLevel: 0, pastedText: payload.text ?? null });
        returnToIdleAfter(SUCCESS_FLASH_MS);
        break;
      case 'error':
        // A failed dictation clears any pending in-panel turn — the existing
        // error capsule takes the dock (worth the morph for a real failure).
        if (panelPendingRef.current) updatePanelPending(null);
        if (
          stateRef.current === 'recording'
          || stateRef.current === 'transcribing'
          || stateRef.current === 'polishing'
        ) {
          stateRef.current = 'error';
          setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: payload.text ?? 'Dictation failed', partialTranscript: '' });
          returnToIdleAfter(ERROR_FLASH_MS);
        }
        break;
      default:
        break;
    }
  }, [beginRecording, returnToIdleAfter, setState, updatePanelPending]);

  // Subscribe to the broadcast STT event stream.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<SttEventPayload>('o8:stt-event', (e) => handleEvent(e.payload)))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
        // Confirm the dock webview actually subscribed — surfaces in o8.log so
        // we can tell a non-morphing dock from one that never wired the listener.
        dockLog('subscribed to o8:stt-event');
      })
      .catch((err) => {
        console.warn('[dock-pill] failed to subscribe to o8:stt-event', err);
        dockLog(`subscribe FAILED: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      disposed = true;
      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch { /* noop */ }
        unlistenRef.current = null;
      }
    };
  }, [handleEvent]);

  // ── TTS playback state (o8:tts-state) — drives the play/pause/stop controls ──
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ state?: TtsControlState }>('o8:tts-state', (e) => {
        const next = e.payload?.state;
        if (next === 'playing' || next === 'paused' || next === 'idle') {
          setTtsState(next);
        }
      }))
      .then((unlisten) => {
        if (disposed) { unlisten(); return; }
        off = unlisten;
      })
      .catch((err) => dockLog(`tts-state subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      if (off) { try { off(); } catch { /* noop */ } off = null; }
    };
  }, []);

  const handleTogglePause = useCallback(() => { invokeCmd('tts_toggle_pause'); }, []);
  const handleStop = useCallback(() => { invokeCmd('tts_stop'); }, []);

  // Keep a ref of the live thread for the open-time resume decision.
  useEffect(() => { askThreadRef.current = askThread; }, [askThread]);

  const closeAsk = useCallback(() => {
    if (!askOpenRef.current) return;
    // Never collapse mid-turn: a pending in-panel dictation or a working agent
    // owns the panel until its answer lands (openPanel re-arms the idle timer).
    if (panelPendingRef.current || agentWorkingRef.current) return;
    askOpenRef.current = false;
    askLastClosedRef.current = Date.now();
    if (askIdleTimerRef.current) { clearTimeout(askIdleTimerRef.current); askIdleTimerRef.current = null; }
    setAskOpen(false);
    setAskMode('idle');
    invokeCmd('dock_set_expanded', { expanded: false });
  }, []);

  const armAskIdleTimer = useCallback(() => {
    if (askIdleTimerRef.current) clearTimeout(askIdleTimerRef.current);
    askIdleTimerRef.current = setTimeout(() => { closeAsk(); }, ASK_IDLE_COLLAPSE_MS);
  }, [closeAsk]);

  // Grow the dock into the full answer panel. Shared by the Ask flow and the
  // Symon agent flow (an agent result lands in the SAME Symon conversation).
  const openPanel = useCallback(() => {
    askOpenRef.current = true;
    setAskOpen(true);
    invokeCmd('dock_set_expanded', { expanded: true });
    armAskIdleTimer();
  }, [armAskIdleTimer]);

  // ── Ask answer panel events (o8:ask-open / -answer / -error) ──
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const add = (u: () => void) => { if (disposed) u(); else offs.push(u); };
        add(await listen('o8:ask-open', () => {
          const within = Date.now() - askLastClosedRef.current < ASK_RESUME_WINDOW_MS;
          dockLog('ask-open');
          if (!within) setAskThread([]);
          askOpenRef.current = true;
          setAskOpen(true);
          setAskMode('listening');
          // Listening shows the compact capsule with the LIVE transcript +
          // waveform (driven by the system-origin dictation events) — don't grow
          // into the panel until the answer arrives.
          invokeCmd('dock_set_expanded', { expanded: false });
          armAskIdleTimer();
        }));
        add(await listen<{ question?: string; answer?: string }>('o8:ask-answer', (e) => {
          const q = e.payload?.question ?? '';
          const a = e.payload?.answer ?? '';
          dockLog(`ask-answer q="${q.slice(0, 40)}"`);
          setAskThread((prev) => {
            const next = [...prev, { role: 'user' as const, text: q }, { role: 'assistant' as const, text: a }];
            return next.length > ASK_MAX_TURNS ? next.slice(next.length - ASK_MAX_TURNS) : next;
          });
          setAskMode('answer');
          openPanel();
        }));
        add(await listen<{ message?: string }>('o8:ask-error', (e) => {
          const msg = e.payload?.message ?? 'Ask failed';
          dockLog(`ask-error ${msg.slice(0, 40)}`);
          setAskThread((prev) => [...prev, { role: 'assistant' as const, text: `Error: ${msg}` }]);
          setAskMode('answer');
          openPanel();
        }));
      })
      .catch((err) => dockLog(`ask subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      for (const off of offs) { try { off(); } catch { /* noop */ } }
    };
  }, [armAskIdleTimer, openPanel]);

  // Resolve a pending agent confirm card → tell Rust, clear the card locally.
  const handleAgentConfirm = useCallback((taskId: string, allow: boolean) => {
    invokeCmd('agent_confirm', { taskId, allow });
    setAgentConfirm(null);
  }, []);

  // Memory glint (dossier #4): a quiet one-line chip under the dock that fades
  // in, holds ~4s, fades out. Driven by `kind: glint` agent events.
  const [glint, setGlint] = useState<string | null>(null);
  const [glintFading, setGlintFading] = useState(false);
  const glintTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const showGlint = useCallback((text: string) => {
    for (const t of glintTimersRef.current) clearTimeout(t);
    glintTimersRef.current = [];
    setGlint(text);
    setGlintFading(false);
    glintTimersRef.current.push(setTimeout(() => setGlintFading(true), 4200));
    glintTimersRef.current.push(setTimeout(() => { setGlint(null); setGlintFading(false); }, 4800));
  }, []);
  useEffect(() => {
    return () => { for (const t of glintTimersRef.current) clearTimeout(t); };
  }, []);

  // Fleet visibility (dossier #8): worker-pulse pushes `o8:worker-status`;
  // the idle sliver carries the orbit + count, tap expands the detail capsule.
  const [workers, setWorkers] = useState<{ count: number; repos: string[] }>({ count: 0, repos: [] });
  const [showWorkers, setShowWorkers] = useState(false);
  const showWorkersTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ count?: number; repos?: string[] }>('o8:worker-status', (e) => {
        const count = Math.max(0, e.payload?.count ?? 0);
        setWorkers({ count, repos: e.payload?.repos ?? [] });
        if (count === 0) setShowWorkers(false);
      }))
      .then((u) => { unlisten = u; })
      .catch((err) => dockLog(`worker-status subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      unlisten?.();
      if (showWorkersTimerRef.current) clearTimeout(showWorkersTimerRef.current);
    };
  }, []);

  // ── Symon voice agent events (o8:agent-confirm / o8:agent-task-event) ──
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const add = (u: () => void) => { if (disposed) u(); else offs.push(u); };
        add(await listen<{ taskId?: string; tool?: string; summary?: string }>('o8:agent-confirm', (e) => {
          const taskId = e.payload?.taskId ?? '';
          const tool = e.payload?.tool ?? '';
          const summary = e.payload?.summary ?? 'Run this action?';
          dockLog(`agent-confirm ${tool}`);
          if (taskId) setAgentConfirm({ taskId, tool, summary });
        }));
        add(await listen<{ kind?: string; status?: string; taskId?: string; result?: string; intent?: string; tool?: string; glint?: string }>('o8:agent-task-event', (e) => {
          const kind = e.payload?.kind;
          if (kind === 'tool_call') {
            // Track the live tool so the working capsule can say "Synthesizing…"
            // for the Brain (o8_ask) vs a generic "Working…".
            if (e.payload?.tool) setAgentTool(e.payload.tool);
            return;
          }
          if (kind === 'glint') {
            // Memory surfaced (dossier #4): one quiet line under the dock.
            const g = e.payload?.glint;
            if (g === 'recovered') showGlint('Recovered — found another way');
            else if (g === 'remembered') showGlint('Remembered');
            return;
          }
          if (kind !== 'status') return;
          const status = e.payload?.status;
          const tid = e.payload?.taskId;
          if (status === 'running') {
            setAgentWorking(true);
            agentWorkingRef.current = true;
            setAgentTool('');
            setAgentStartedAt(Date.now());
            if (e.payload?.intent) agentIntentRef.current = e.payload.intent;
            // The agent claimed the pending in-panel turn: lock its text to
            // the polished intent and cancel the discard timeout.
            if (panelPendingRef.current) {
              if (pendingHandoffTimerRef.current) {
                clearTimeout(pendingHandoffTimerRef.current);
                pendingHandoffTimerRef.current = null;
              }
              updatePanelPending({
                phase: 'handoff',
                text: e.payload?.intent || panelPendingRef.current.text,
              });
            }
          } else if (status === 'done' || status === 'failed') {
            // Dual-emit guard: the dock receives this terminal event twice
            // (emit_to dock + broadcast). Handle each task's done once.
            if (tid && agentDoneRef.current === tid) return;
            if (tid) agentDoneRef.current = tid;
            setAgentWorking(false);
            agentWorkingRef.current = false;
            setAgentTool('');
            // The real turns replace the pending in-panel rows in place — but
            // ONLY a handed-off pending. A listening/polishing pending belongs
            // to a NEWER dictation the user already started over this task.
            if (panelPendingRef.current?.phase === 'handoff') updatePanelPending(null);
            // Only clear a pending confirm if it belongs to THIS task.
            setAgentConfirm((c) => (c && c.taskId === tid ? null : c));
            // Show the spoken answer in the panel instead of collapsing to idle.
            // The agent IS Symon, so it lands in the same conversation thread:
            // the intent as a "You" turn, the result as a "Symon" turn.
            const intent = agentIntentRef.current.trim();
            const answer = (e.payload?.result ?? '').trim()
              || (status === 'failed' ? 'Symon hit an error.' : 'Done.');
            agentIntentRef.current = '';
            setAskThread((prev) => {
              const turns: AskTurn[] = [];
              if (intent) turns.push({ role: 'user', text: intent });
              turns.push({ role: 'assistant', text: answer });
              const next = [...prev, ...turns];
              return next.length > ASK_MAX_TURNS ? next.slice(next.length - ASK_MAX_TURNS) : next;
            });
            setAskMode('answer');
            openPanel();
          }
        }));
      })
      .catch((err) => dockLog(`agent subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      disposed = true;
      for (const off of offs) { try { off(); } catch { /* noop */ } }
    };
  }, [openPanel, showGlint, updatePanelPending]);

  // Escape collapses the open Ask panel.
  useEffect(() => {
    if (!isTauri()) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && askOpenRef.current) closeAsk(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAsk]);

  // Drag-files-into-Symon (dossier #3): a Finder drag over the dock morphs the
  // sliver into the glass drop zone; a drop stages content for the next ⌥-ask
  // (agent_files_stage) and shows the chips for a beat before relaxing.
  const [stagedChips, setStagedChips] = useState<StagedChip[] | null>(null);
  const stagedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropActive = useDockFileDrop(useCallback((chips: StagedChip[]) => {
    setStagedChips(chips);
    dockLog(`staged ${chips.length} dropped file(s)`);
    if (stagedTimerRef.current) clearTimeout(stagedTimerRef.current);
    stagedTimerRef.current = setTimeout(() => setStagedChips(null), 6000);
  }, []));
  useEffect(() => {
    return () => {
      if (stagedTimerRef.current) clearTimeout(stagedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Hit-rect reporting: the dock WINDOW is a 520-wide strip that would hijack
  // every click at the top of the screen, so the Rust side keeps it
  // click-through except while the cursor is over the PAINTED pill. Report the
  // content wrapper's rect on every morph (ResizeObserver fires through the
  // 0.5s geometry transition; rAF-throttled so we invoke at most per-frame).
  const hitRectHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    const host = hitRectHostRef.current;
    if (!host) return;
    let raf = 0;
    const report = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = host.getBoundingClientRect();
        invokeCmd('dock_set_hit_rect', { x: r.left, y: r.top, w: r.width, h: r.height });
      });
    };
    const ro = new ResizeObserver(report);
    ro.observe(host);
    report();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // The dock window is transparent at the OS level (clearColor + setOpaque
  // false). The page's html/body must NOT paint a background or the window
  // shows a solid rectangle instead of just the pill. globals.css / the root
  // layout set #1C1C1E; override to transparent for this surface only.
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

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        // paddingTop 0 → the idle capsule's square top edge sits flush at the
        // window top, which the Rust side anchors flush to the screen top edge
        // (DOCK_TOP_INSET = 0). No gap above the capsule (Symon notch behavior).
        paddingTop: 0,
        background: 'transparent',
        // The React layer keeps the dead-zone tight: the wrapper ignores
        // pointer events, only the pill itself (hideCancel = no buttons) sits
        // on top. set_ignore_cursor_events stays FALSE on the Rust side.
        pointerEvents: 'none',
      }}
    >
      <div
        style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
        onMouseMove={() => { if (askOpenRef.current) armAskIdleTimer(); }}
        onClick={() => {
          // Tap the resting sliver while the worker orbit is up → transient
          // capsule naming the in-flight packets (dossier #8).
          if (snapshot.state === 'idle' && ttsState === 'idle' && !askOpen && !agentWorking && workers.count > 0) {
            setShowWorkers(true);
            if (showWorkersTimerRef.current) clearTimeout(showWorkersTimerRef.current);
            showWorkersTimerRef.current = setTimeout(() => setShowWorkers(false), 5000);
          }
        }}
        onDoubleClick={() => {
          // Double-tap the IDLE dock to open the standalone Voice settings
          // window (Symon parity — works even with the main app closed). Gated
          // to idle so it never fires over the ask panel / speaking controls.
          if (snapshot.state === 'idle' && ttsState === 'idle' && !askOpen) {
            invokeCmd('open_voice_settings');
          }
        }}
      >
        {/* The ONE morphing notch dock — idle ⇄ listening ⇄ thinking ⇄ done ⇄
            ask, in place (Symon NotchSurface). Not the in-window floating pill.
            The hit-rect ref wraps ONLY the pill — the glint chip below is
            visual-only (pointer-events none) and must not extend the
            click-accepting zone over the menu bar. */}
        <div ref={hitRectHostRef} style={{ display: 'flex' }}>
          <DockNotchSurface
            snapshot={snapshot}
            ttsState={ttsState}
            onTogglePause={handleTogglePause}
            onStop={handleStop}
            askOpen={askOpen}
            askMode={askMode}
            askThread={askThread}
            onCloseAsk={closeAsk}
            agentConfirm={agentConfirm}
            agentWorking={agentWorking}
            agentTool={agentTool}
            agentStartedAt={agentStartedAt}
            onAgentConfirm={handleAgentConfirm}
            dropActive={dropActive}
            stagedFiles={stagedChips}
            workerCount={workers.count}
            workerRepos={workers.repos}
            showWorkers={showWorkers}
            panelPending={panelPending}
          />
        </div>
        {glint ? (
          <div
            style={{
              marginTop: 6,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 9,
              background: 'linear-gradient(rgba(20,24,34,0.6), rgba(14,18,28,0.54))',
              border: '1px solid rgba(255,255,255,0.14)',
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              color: 'rgba(255, 255, 255, 0.82)',
              textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
              whiteSpace: 'nowrap',
              opacity: glintFading ? 0 : 1,
              transition: 'opacity 0.5s ease',
              animation: 'o8GlintIn 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
              pointerEvents: 'none',
            }}
          >
            {glint}
            <style>{'@keyframes o8GlintIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }'}</style>
          </div>
        ) : null}
      </div>
    </div>
  );
}
