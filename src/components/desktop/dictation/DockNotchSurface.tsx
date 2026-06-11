'use client';

/**
 * DockNotchSurface — the screen-dock morphing pill, a faithful React/inline-style
 * port of Symon's `NotchSurface.svelte` (aqua-color).
 *
 * THE ONE PILL. Unlike the in-window `DictationPillView` (which cross-fades a
 * separate idle sliver and a separate floating capsule), this surface is a
 * SINGLE `.ndock` element that morphs IN PLACE — its width / height / radius /
 * background animate via a CSS spring while the inner content swaps per state:
 *
 *   idle       → 128×16 brand-gradient sliver, flush at the very top edge
 *   listening  → 248×40 darkened capsule: live EQ waveform + partial transcript
 *   polishing  → 248×40 darkened capsule: the squiggle loader (transcribing too)
 *   success    → 420×44 wide capsule: a brief "done" flash w/ green underline
 *   error      → 420×44 wide capsule: red-tinted flash
 *
 * then collapses back to idle. This is the exact Symon notch-dock behavior:
 * idle ⇄ capsule, never two stacked elements.
 *
 * It is rendered ONLY by the always-on screen dock window (`/dictation-pill`),
 * which is top-center / level-25 / transparent. The window provides the
 * position; this surface hangs from the top (alignItems: flex-start, top edge
 * square). The in-window mic-button pill (`DictationPill`) is a separate
 * component and is UNCHANGED.
 *
 * NOTE (operator directive): the literal color values below mirror Symon's
 * palette verbatim — a documented TEMPORARY exception to the
 * "theme tokens, never raw rgba" rule, identical to DictationPill.tsx. This
 * preserves Symon's exact LOOK while obeying the inline-styles-only rule.
 */

import { useEffect, useRef, useState } from 'react';
import type { DictationSnapshot, DictationState } from './types';
import { DockAskPanel, type AskTurn } from './DockAskPanel';

// ── Symon brand gradient (cyan → periwinkle → pink → gold) ──
// Verbatim from SymonPillWaveform.svelte / SquiggleLoader.svelte.
const GRADIENT_STOPS: Array<[number, string]> = [
  [0.0, 'rgba(136, 209, 241, 0.92)'],
  [0.42, 'rgba(177, 180, 229, 0.95)'],
  [0.72, 'rgba(245, 184, 196, 0.92)'],
  [1.0, 'rgba(244, 201, 119, 0.92)'],
];

// ── EQ canvas geometry — Symon's SymonPillWaveform.svelte values ──
const BAR_COUNT = 30;
const BAR_WIDTH = 2;
const BAR_GAP = 2.5;
const INNER_W = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP; // 132.5
const INNER_H = 24;

const WEIGHTS = (() => {
  const out = new Array<number>(BAR_COUNT);
  const center = (BAR_COUNT - 1) / 2;
  for (let i = 0; i < BAR_COUNT; i++) {
    const dist = Math.abs(i - center) / center;
    out[i] = Math.exp(-1.8 * dist * dist);
  }
  return out;
})();

// ── Symon notch idle sliver gradient (NotchSurface.svelte `.ndock--idle`) ──
const SYMON_IDLE_GRADIENT = 'linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%)';
// The darkened brand capsule background used by `.ndock--listening/--thinking/
// --done` (so the gradient wave pops over a dimmed surface). Verbatim.
const SYMON_CAPSULE_BG =
  'linear-gradient(rgba(13, 11, 26, 0.5), rgba(13, 11, 26, 0.5)),'
  + ' linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%)';

// ── Glass dock theme (Theme tab → Dock = Glass) — clear/frosted instead of the
// Symon multicolor. The capsule/panel rely on backdrop blur for the frost.
// The idle sliver keeps the WHITE/clear tint — operator-locked 2026-06-11:
// white reads "the most glass," and the fix for the milky look was never the
// dark tint, it was giving the sliver the same strong backdrop blur+saturate
// the Option-held capsule has (see `idleBlur` below). So: white tint + open
// capsule's saturation = the clear glass the operator wants.
const GLASS_IDLE = 'linear-gradient(rgba(255,255,255,0.20), rgba(232,238,250,0.10))';
const GLASS_CAPSULE_BG = 'linear-gradient(rgba(20,24,34,0.52), rgba(14,18,28,0.46))';
// Translucent glass for the read panels (answer + confirm card) — transparent
// like every other dock mode (the closed/idle sliver, the capsules). The dock
// stays glass in ALL modes; backdrop blur + saturate carry the frost.
const GLASS_PANEL_BG = 'linear-gradient(rgba(16,20,30,0.52), rgba(12,16,26,0.46))';
const GLASS_BLUR: React.CSSProperties = {
  backdropFilter: 'blur(26px) saturate(150%)', WebkitBackdropFilter: 'blur(26px) saturate(150%)',
};

// SquiggleLoader path — verbatim from SquiggleLoader.svelte.
const SQUIGGLE_PATH =
  'M8 28C32 22 48 14 72 14C96 14 108 34 132 34C156 34 170 12 198 12C230 12 238 38 272 38C304 38 316 18 344 18C372 18 388 28 408 28';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Symon `mode` the notch dock morphs through, mapped from DictationState. */
type NotchMode = 'idle' | 'listening' | 'thinking' | 'done';

function modeFor(state: DictationState): NotchMode {
  if (state === 'recording' || state === 'requesting-mic') return 'listening';
  if (state === 'transcribing' || state === 'polishing') return 'thinking';
  if (state === 'success' || state === 'error') return 'done';
  return 'idle';
}

/**
 * NotchWaveCanvas — the centered-bulge gaussian EQ, ported 1:1 from
 * SymonPillWaveform.svelte. Drives off the live audio level + an ambient
 * shimmer so it's never dead-flat while listening.
 */
function NotchWaveCanvas({ listening, levelRef }: {
  listening: boolean;
  levelRef: React.RefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentLevelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const targetLevelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const rafRef = useRef<number | null>(null);
  const listeningRef = useRef(listening);
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== INNER_W * dpr || canvas.height !== INNER_H * dpr) {
        canvas.width = INNER_W * dpr;
        canvas.height = INNER_H * dpr;
        canvas.style.width = `${INNER_W}px`;
        canvas.style.height = `${INNER_H}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, INNER_W, INNER_H);

      const t = now / 1000;
      const isListening = listeningRef.current;
      const lvl = levelRef.current ?? 0;
      const ambientBase = isListening ? 0.18 : 0.12;
      const target = targetLevelsRef.current;
      const current = currentLevelsRef.current;

      for (let i = 0; i < BAR_COUNT; i++) {
        const phase = i * 0.42;
        const ambient = ambientBase + 0.08 * Math.sin(t * 2.2 + phase);
        const level = Math.max(0, Math.min(1, lvl));
        const driven = isListening ? level : 0;
        const amp = Math.max(ambient, driven * WEIGHTS[i]) + driven * 0.08 * Math.sin(t * 12 + phase);
        target[i] = Math.max(0.04, Math.min(1, amp));
      }

      const smoothing = 0.22;
      const g = ctx.createLinearGradient(0, 0, INNER_W, 0);
      for (const [stop, color] of GRADIENT_STOPS) g.addColorStop(stop, color);
      ctx.fillStyle = g;

      for (let i = 0; i < BAR_COUNT; i++) {
        current[i] = lerp(current[i], target[i], smoothing);
        const barH = Math.max(2, current[i] * INNER_H);
        const x = i * (BAR_WIDTH + BAR_GAP);
        const y = (INNER_H - barH) / 2;
        const r = Math.min(BAR_WIDTH / 2, barH / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + BAR_WIDTH - r, y);
        ctx.quadraticCurveTo(x + BAR_WIDTH, y, x + BAR_WIDTH, y + r);
        ctx.lineTo(x + BAR_WIDTH, y + barH - r);
        ctx.quadraticCurveTo(x + BAR_WIDTH, y + barH, x + BAR_WIDTH - r, y + barH);
        ctx.lineTo(x + r, y + barH);
        ctx.quadraticCurveTo(x, y + barH, x, y + barH - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [levelRef]);

  return (
    <canvas
      ref={canvasRef}
      width={INNER_W}
      height={INNER_H}
      style={{
        width: INNER_W,
        height: INNER_H,
        display: 'block',
        opacity: listening ? 1 : 0.9,
        filter: listening ? 'saturate(1.06) brightness(1.04)' : 'saturate(0.96) brightness(0.98)',
        transition: 'opacity 180ms ease, filter 180ms ease',
      }}
      aria-hidden="true"
    />
  );
}

/** SquiggleLoader — dash-animated wave path stroked w/ the Symon gradient. */
function NotchSquiggle() {
  return (
    <div
      aria-label="Polishing"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 150, height: 26, overflow: 'hidden' }}
    >
      <svg viewBox="0 0 416 52" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', width: 150, height: 26 }} aria-hidden="true">
        <defs>
          <linearGradient id="o8-dock-squiggle" x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#88D1F1" />
            <stop offset="34%" stopColor="#B1B4E5" />
            <stop offset="72%" stopColor="#F5B8C4" />
            <stop offset="100%" stopColor="#F4C977" />
          </linearGradient>
        </defs>
        <path
          d={SQUIGGLE_PATH}
          pathLength={100}
          fill="none"
          stroke="rgba(255, 255, 255, 0.09)"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SQUIGGLE_PATH}
          pathLength={100}
          fill="none"
          stroke="url(#o8-dock-squiggle)"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: '36 64',
            strokeDashoffset: 0,
            filter: 'drop-shadow(0 0 10px rgba(177, 180, 229, 0.24))',
            animation: 'o8DockSquiggle 2.1s ease-in-out infinite alternate',
          }}
        />
      </svg>
    </div>
  );
}

/** o8 binary-orbit — two dots 180° apart circling a center, the o8 "long-running
 * op underway" motion (parity with the main app's orbit + the settings
 * time-saved mark). Dainty/small; inline-animation + shared `<style>` keyframe
 * (o8DockOrbit) so it obeys the inline-styles-only rule. 1.6s active cadence. */
function NotchOrbit({ size = 13, color = '#fff' }: { size?: number; color?: string }) {
  const dot = size <= 10 ? 2.5 : 3;
  return (
    <span aria-hidden style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0, color }}>
      <span style={{ position: 'absolute', inset: 0, animation: 'o8DockOrbit 1.6s linear infinite' }}>
        <span style={{ position: 'absolute', top: 0, left: '50%', width: dot, height: dot, marginLeft: -dot / 2, borderRadius: '50%', background: 'currentColor' }} />
        <span style={{ position: 'absolute', bottom: 0, left: '50%', width: dot, height: dot, marginLeft: -dot / 2, borderRadius: '50%', background: 'currentColor', opacity: 0.55 }} />
      </span>
    </span>
  );
}

/** Live elapsed timer for the working capsule — ticks each second from when the
 * task started, so a long synthesis reads as "still going". Compact: `7s` under
 * a minute, `1:23` over. */
function WorkingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const label = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 300,
        letterSpacing: '0.2px',
        color: 'rgba(255, 255, 255, 0.55)',
        fontVariantNumeric: 'tabular-nums',
        textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
      }}
    >
      {label}
    </span>
  );
}

/** A small circular control button in the speaking capsule (raw SVG icon —
 * React icon components don't render in the Tauri webview). */
function NotchControlButton({ label, onClick, children }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: 'rgba(255, 255, 255, 0.16)',
        border: '1px solid rgba(255, 255, 255, 0.26)',
        color: '#fff',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
        WebkitBackdropFilter: 'blur(4px)',
        backdropFilter: 'blur(4px)',
        transition: 'background 140ms ease, transform 120ms ease',
      } as React.CSSProperties}
    >
      {children}
    </button>
  );
}

/** Play / pause / stop glyphs — raw SVG, 13px, currentColor. */
function PlayGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M6.5 4.2a1 1 0 0 1 1.5-.87l8.5 4.93a1 1 0 0 1 0 1.73l-8.5 4.94A1 1 0 0 1 6.5 14.06V4.2Z" fill="currentColor" />
    </svg>
  );
}
function PauseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="5" y="4" width="3.4" height="12" rx="1.2" fill="currentColor" />
      <rect x="11.6" y="4" width="3.4" height="12" rx="1.2" fill="currentColor" />
    </svg>
  );
}
function StopGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="10" height="10" rx="2.4" fill="currentColor" />
    </svg>
  );
}

/** Minimal speed slider for the speaking capsule — 0.8×–1.2×, snaps in 0.05
 * steps. Pitch-PRESERVING (ElevenLabs `speed` server-side), so the band is the
 * gentle range it supports — no chipmunk. Pointer-driven (no native <input> —
 * unreliable in the Tauri WKWebview). `onCommit` persists the rate; it applies
 * to Symon's NEXT utterance. */
const SPEED_MIN = 0.8;
const SPEED_MAX = 1.2;
const SPEED_TRACK = 58;
function NotchSpeedSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const clamp = (v: number) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
  const snap = (v: number) => clamp(Math.round(v * 20) / 20);
  const fromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const t = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return snap(SPEED_MIN + t * (SPEED_MAX - SPEED_MIN));
  };
  const apply = (clientX: number) => {
    const v = fromClientX(clientX);
    if (v !== value) onCommit(v);
  };
  const pct = ((clamp(value) - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Speaking speed"
        aria-valuemin={SPEED_MIN}
        aria-valuemax={SPEED_MAX}
        aria-valuenow={value}
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          apply(e.clientX);
        }}
        onPointerMove={(e) => { if (draggingRef.current) apply(e.clientX); }}
        onPointerUp={() => { draggingRef.current = false; }}
        style={{
          position: 'relative',
          width: SPEED_TRACK,
          height: 14,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          touchAction: 'none',
        }}
      >
        <div style={{ position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.22)' }} />
        <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.6)' }} />
        <div
          style={{
            position: 'absolute',
            left: `calc(${pct}% - 6px)`,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'rgba(255,255,255,0.82)',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 22,
          textShadow: '0 1px 4px rgba(0,0,0,0.35)',
        }}
      >
        {Number.isInteger(value) ? `${value}×` : `${value.toFixed(2).replace(/0$/, '')}×`}
      </span>
    </div>
  );
}

interface DockNotchSurfaceProps {
  snapshot: DictationSnapshot;
  /** TTS playback state — when playing/paused (and not dictating), the dock
   * morphs into the speaking capsule with play/pause + stop controls. */
  ttsState?: 'idle' | 'playing' | 'paused';
  onTogglePause?: () => void;
  onStop?: () => void;
  /** Ask answer panel (voice P4 C3) — when open (and not dictating/speaking)
   * the dock grows into the Q/o8 thread panel. */
  askOpen?: boolean;
  askMode?: 'idle' | 'listening' | 'answer';
  askThread?: AskTurn[];
  onCloseAsk?: () => void;
  /** Symon voice agent — a pending confirm card for a risky action (Allow /
   * Cancel), the working indicator while the loop runs, and the resolver. */
  agentConfirm?: { taskId: string; tool: string; summary: string } | null;
  agentWorking?: boolean;
  /** Current running tool (from tool_call events) — 'o8_ask' shows "Synthesizing…". */
  agentTool?: string;
  /** Epoch ms when the working task started, for the live elapsed timer. */
  agentStartedAt?: number;
  onAgentConfirm?: (taskId: string, allow: boolean) => void;
  /** Drag-files-into-Symon (dossier #3): a Finder drag is over the dock window
   * → the sliver morphs into the glass drop zone. */
  dropActive?: boolean;
  /** Files just staged by a drop — shown as chips, then the dock relaxes back
   * to idle (the staged context lives on the Rust side for the next ask). */
  stagedFiles?: { name: string; size: number }[] | null;
  /** Fleet visibility (dossier #8) — packets in flight from `o8:worker-status`.
   * count > 0 puts the slow orbit + count in the idle sliver. */
  workerCount?: number;
  /** Lanes genuinely WORKING (running/dispatching) — drives the spinning orbit. */
  workerWorking?: number;
  /** Lanes parked on the operator (review / awaiting input) — static amber dot,
   * "waiting on you" copy. A paused packet must not read as active work. */
  workerWaiting?: number;
  workerRepos?: string[];
  /** Tap-the-sliver expansion: a transient capsule naming the in-flight work. */
  showWorkers?: boolean;
  /** Chat continuity: an agent-lane dictation running INSIDE the open panel.
   * While set, the panel keeps the dock (no capsule collapse) and renders the
   * live transcript as a pending You turn. */
  panelPending?: { phase: 'listening' | 'polishing' | 'handoff'; text: string } | null;
  /** Symon's speaking speed (1×–3×) — the speaking capsule's live slider. */
  speechSpeed?: number;
  onSpeechSpeed?: (rate: number) => void;
}

/**
 * DockNotchSurface — the single morphing notch dock element.
 *
 * One `.ndock` element. Its geometry/background animate per state via the
 * Symon spring; the content inside swaps. idle ⇄ listening ⇄ thinking ⇄ done.
 */
export function DockNotchSurface({
  snapshot,
  ttsState = 'idle',
  onTogglePause,
  onStop,
  askOpen = false,
  askMode = 'idle',
  askThread = [],
  onCloseAsk,
  agentConfirm = null,
  agentWorking = false,
  agentTool = '',
  agentStartedAt = 0,
  onAgentConfirm,
  dropActive = false,
  stagedFiles = null,
  workerCount = 0,
  workerWorking = 0,
  workerWaiting = 0,
  workerRepos = [],
  showWorkers = false,
  panelPending = null,
  speechSpeed = 1,
  onSpeechSpeed,
}: DockNotchSurfaceProps) {
  const { state, audioLevel, partialTranscript, error, pastedText } = snapshot;
  const dictationMode = modeFor(state);
  // The speaking capsule shows when TTS is playing/paused AND no dictation is
  // active. The TTS engine drives the dock purely via `o8:tts-state` (it no
  // longer emits the dictation `system-start`), so when the user holds Fn to
  // talk OVER the TTS, real dictation sets `dictationMode` and wins the dock —
  // they see their recording waveform, not the speaking controls.
  const isSpeaking = dictationMode === 'idle' && (ttsState === 'playing' || ttsState === 'paused');
  // The Ask panel renders while open, EXCEPT when a real dictation takes the
  // dock (dictationMode !== idle wins — you can Fn-dictate over it). It DOES win
  // over isSpeaking, because the Ask answer is itself read aloud and the panel
  // should stay visible while its answer speaks. Chat continuity: a pending
  // in-panel dictation (panelPending) keeps the panel through the recording —
  // the live words render as a pending turn INSIDE it, not in the capsule.
  const isAsking = askOpen && (dictationMode === 'idle' || !!panelPending);
  // While listening for the question (empty thread) the panel shows the compact
  // capsule + waveform; once an answer lands it's the full grown panel.
  const askListening = isAsking && askMode === 'listening' && askThread.length === 0;
  const mode = dictationMode;
  const isError = state === 'error';
  // Symon voice agent surfaces. A pending confirm wins over everything except a
  // real dictation (you can Option-talk over it). The working indicator
  // shows while the loop runs and nothing else owns the dock.
  const isConfirming = !!agentConfirm && dictationMode === 'idle';
  const isAgentWorking =
    agentWorking && !isConfirming && dictationMode === 'idle' && !isAsking && !isSpeaking;
  // Drop zone wins while a Finder drag is live (the user is mid-gesture) —
  // but never over an active dictation, the confirm gate, or the ask panel.
  const isDropTarget = dropActive && dictationMode === 'idle' && !isConfirming && !isAsking;
  // Chips show right after a drop, when nothing else owns the dock.
  const isStagedChips =
    !isDropTarget && !!stagedFiles?.length && dictationMode === 'idle'
    && !isConfirming && !isAsking && !isSpeaking && !isAgentWorking;
  // Transient workers capsule (tap the sliver while the orbit is up).
  const isWorkersInfo =
    showWorkers && workerCount > 0 && dictationMode === 'idle' && !isConfirming
    && !isAsking && !isSpeaking && !isAgentWorking && !isDropTarget && !isStagedChips;

  // Live ref for the canvas RAF loop (avoid re-running the effect per frame).
  const levelRef = useRef<number>(audioLevel);
  useEffect(() => { levelRef.current = audioLevel; }, [audioLevel]);

  // Dock theme (Theme tab → Dock). 'symon' = the multicolor brand surface,
  // 'glass' = clear/frosted. Shared-origin localStorage; tracks the storage
  // event. Also reads the Theme-tab glass sliders ('o8:vs-glass') so the dock
  // glass pushes with the SAME Frost / Saturation / Brightness knobs as the
  // settings shell — null until the user tunes (falls back to the dock default).
  const [dockTheme, setDockTheme] = useState<'symon' | 'glass'>('symon');
  const [tunedBlur, setTunedBlur] = useState<React.CSSProperties | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        setDockTheme(localStorage.getItem('o8:dock-theme') === 'glass' ? 'glass' : 'symon');
        const raw = localStorage.getItem('o8:vs-glass');
        if (raw) {
          const c = JSON.parse(raw);
          const frost = typeof c.frost === 'number' ? c.frost : 26;
          const sat = typeof c.saturate === 'number' ? c.saturate : 150;
          const bright = typeof c.brightness === 'number' ? c.brightness : 104;
          const f = `blur(${Math.round(frost)}px) saturate(${(sat / 100).toFixed(2)}) brightness(${(bright / 100).toFixed(2)})`;
          setTunedBlur({ backdropFilter: f, WebkitBackdropFilter: f });
        } else {
          setTunedBlur(null);
        }
      } catch { /* noop */ }
    };
    read();
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, []);
  const glassDock = dockTheme === 'glass';
  const idleBg = glassDock ? GLASS_IDLE : SYMON_IDLE_GRADIENT;
  const capsuleBg = glassDock ? GLASS_CAPSULE_BG : SYMON_CAPSULE_BG;
  const capsuleBlur: React.CSSProperties = glassDock ? (tunedBlur ?? GLASS_BLUR) : {};

  const trimmedPartial = partialTranscript.trim();

  // ── Per-mode geometry (verbatim Symon NotchSurface dimensions) ──
  // idle: 128×16 sliver. listening/thinking: 248×40 capsule. done: 420×44 wide.
  const geometry: React.CSSProperties = (() => {
    if (isConfirming) {
      // Confirm card — wide enough for the summary + Allow/Cancel. Fits the
      // collapsed 520×120 dock window, so no expand needed.
      return {
        width: 420,
        height: 96,
        borderRadius: '0 0 24px 24px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 14px 32px rgba(40, 40, 80, 0.36)',
      } as React.CSSProperties;
    }
    if (isDropTarget) {
      // Glass drop zone — the sliver continues into a receiving surface. The
      // soft inner orange ring (Symon Points vocabulary) says "receivable"
      // without a Material dashed outline.
      return {
        width: 320,
        height: 64,
        borderRadius: '0 0 24px 24px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.45)',
        boxShadow: '0 10px 26px rgba(40, 40, 80, 0.32), inset 0 0 0 1.5px rgba(255, 90, 31, 0.45)',
      } as React.CSSProperties;
    }
    if (isStagedChips) {
      return {
        width: 420,
        height: 56,
        borderRadius: '0 0 22px 22px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
      } as React.CSSProperties;
    }
    if (isAgentWorking) {
      return {
        width: 248,
        height: 40,
        borderRadius: '0 0 20px 20px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
      } as React.CSSProperties;
    }
    if (isWorkersInfo) {
      return {
        width: 320,
        height: 44,
        borderRadius: '0 0 20px 20px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
      } as React.CSSProperties;
    }
    if (isAsking) {
      if (askListening) {
        // Listening for the question — the compact brand capsule + waveform.
        return {
          width: 248,
          height: 40,
          borderRadius: '0 0 20px 20px',
          background: capsuleBg, ...capsuleBlur,
          borderColor: 'rgba(255, 255, 255, 0.4)',
          boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
        } as React.CSSProperties;
      }
      // Answer panel — translucent glass like the rest of the dock (transparent
      // in every mode). The root width/height/radius transition animates the
      // 248→420 grow for free.
      return {
        width: 420,
        height: 380,
        borderRadius: '0 0 26px 26px',
        background: glassDock
          ? GLASS_PANEL_BG
          : 'linear-gradient(rgba(13, 11, 26, 0.62), rgba(13, 11, 26, 0.62)),'
            + ' linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%)',
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 16px 34px rgba(0, 0, 0, 0.34)',
        backdropFilter: 'blur(34px) saturate(140%)',
        WebkitBackdropFilter: 'blur(34px) saturate(140%)',
      } as React.CSSProperties;
    }
    if (isSpeaking) {
      // Speaking capsule — the darkened brand surface with the controls +
      // the speed slider (1×–3×). Wider than the bare play/stop capsule.
      return {
        width: 280,
        height: 40,
        borderRadius: '0 0 20px 20px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
      } as React.CSSProperties;
    }
    if (mode === 'idle') {
      // Glass sliver carries the SAME blur/saturate as the open capsule (incl.
      // the operator's tuned sliders) so closed and open read as one surface.
      const idleBlur: React.CSSProperties = glassDock
        ? capsuleBlur
        : {
            backdropFilter: 'blur(10px) saturate(160%)',
            WebkitBackdropFilter: 'blur(10px) saturate(160%)',
          };
      return {
        width: 128,
        height: 16,
        borderRadius: '0 0 14px 14px',
        background: idleBg,
        borderColor: 'rgba(255, 255, 255, 0.45)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28), inset 0 -2px 6px rgba(120, 110, 160, 0.22)',
        ...idleBlur,
      } as React.CSSProperties;
    }
    if (mode === 'done') {
      return {
        // listening recording with a long transcript widens like Symon's listening
        // footprint; success/error use the wide 420 done capsule.
        width: 420,
        height: 44,
        borderRadius: '0 0 20px 20px',
        background: isError
          ? 'linear-gradient(rgba(40, 12, 12, 0.55), rgba(40, 12, 12, 0.55)), linear-gradient(100deg, #ffb4b4 0%, #f7c2c2 46%, #f7d9bf 100%)'
          : capsuleBg,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: isError
          ? '0 8px 22px rgba(80, 30, 30, 0.34), inset 0 -2px 0 #ef4444'
          : '0 8px 22px rgba(40, 40, 80, 0.3), inset 0 -2px 0 #43d6a0',
      } as React.CSSProperties;
    }
    // listening + thinking — the darkened brand capsule. Listening with a long
    // partial transcript grows wider so the words have room (Symon listening
    // footprint grows for words); idle/short stays at the 248 capsule.
    // Listening grows wider for a long partial — capped at 480 so it stays
    // inside the 520px-wide dock window (DOCK_WIDTH in dock_window.rs) with
    // margin on both sides.
    const listeningWide = mode === 'listening' && trimmedPartial.length > 0;
    const width = listeningWide
      ? Math.max(248, Math.min(480, 200 + Math.min(280, trimmedPartial.length * 6)))
      : 248;
    return {
      width,
      height: 40,
      borderRadius: '0 0 20px 20px',
      background: capsuleBg, ...capsuleBlur,
      borderColor: 'rgba(255, 255, 255, 0.4)',
      boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
    } as React.CSSProperties;
  })();

  // ── Inner content per mode ──
  let body: React.ReactNode = null;
  if (isConfirming && agentConfirm) {
    const confirm = agentConfirm;
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 9,
          width: '100%',
          height: '100%',
          paddingLeft: 18,
          paddingRight: 18,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              color: 'rgba(255, 255, 255, 0.7)',
              textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
            }}
          >
            Symon wants to
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 320,
              letterSpacing: '-0.1px',
              color: '#fff',
              textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={confirm.summary}
          >
            {confirm.summary}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => onAgentConfirm?.(confirm.taskId, false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 28,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 14,
              border: '1px solid rgba(255, 255, 255, 0.32)',
              background: 'rgba(255, 255, 255, 0.12)',
              color: 'rgba(255, 255, 255, 0.92)',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: '-0.1px',
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onAgentConfirm?.(confirm.taskId, true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 28,
              paddingLeft: 18,
              paddingRight: 18,
              borderRadius: 14,
              border: '1px solid rgba(255, 255, 255, 0.5)',
              background: 'rgba(255, 255, 255, 0.92)',
              color: '#1a1730',
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: '-0.1px',
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            Allow
          </button>
        </div>
      </div>
    );
  } else if (isDropTarget) {
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: '#fff',
            textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'nowrap',
          }}
        >
          Drop files for Symon
        </span>
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            color: 'rgba(255, 255, 255, 0.6)',
            textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'nowrap',
          }}
        >
          They ride your next question
        </span>
      </div>
    );
  } else if (isStagedChips && stagedFiles) {
    const visible = stagedFiles.slice(0, 3);
    const extra = stagedFiles.length - visible.length;
    const sizeLabel = (n: number) =>
      n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          width: '100%',
          height: '100%',
          paddingLeft: 16,
          paddingRight: 16,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', gap: 6, maxWidth: '100%', overflow: 'hidden' }}>
          {visible.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 22,
                paddingLeft: 9,
                paddingRight: 9,
                borderRadius: 11,
                background: 'rgba(255, 255, 255, 0.14)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                fontSize: 10.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: '#f4f5f7',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 150,
              }}
              title={f.name}
            >
              {f.name}&nbsp;<span style={{ color: 'rgba(255,255,255,0.55)' }}>{sizeLabel(f.size)}</span>
            </span>
          ))}
          {extra > 0 ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 22,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 11,
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                fontSize: 10.5,
                fontWeight: 300,
                color: 'rgba(255, 255, 255, 0.7)',
                whiteSpace: 'nowrap',
              }}
            >
              +{extra}
            </span>
          ) : null}
        </div>
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            color: 'rgba(255, 255, 255, 0.55)',
            textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'nowrap',
          }}
        >
          Staged — hold ⌥ and ask
        </span>
      </div>
    );
  } else if (isAgentWorking) {
    const synthesizing = agentTool === 'o8_ask';
    body = (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          width: '100%',
          height: '100%',
          paddingLeft: 14,
          paddingRight: 14,
          overflow: 'hidden',
        }}
      >
        <NotchOrbit size={13} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'rgba(255, 255, 255, 0.9)',
            textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'nowrap',
          }}
        >
          {synthesizing ? 'Synthesizing…' : 'Working…'}
        </span>
        {agentStartedAt ? <WorkingTimer startedAt={agentStartedAt} /> : null}
      </div>
    );
  } else if (isWorkersInfo) {
    body = (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          width: '100%',
          height: '100%',
          paddingLeft: 16,
          paddingRight: 16,
          overflow: 'hidden',
        }}
      >
        {workerWorking > 0 ? (
          <NotchOrbit size={13} />
        ) : (
          <span
            aria-hidden
            style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255, 159, 67, 0.95)', flexShrink: 0 }}
          />
        )}
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: '#fff',
            textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {workerWorking > 0 && workerWaiting > 0
            ? `${workerWorking} in flight · ${workerWaiting} waiting on you`
            : workerWorking > 0
              ? `${workerWorking} packet${workerWorking === 1 ? '' : 's'} in flight`
              : `${workerWaiting} waiting on you`}
          {workerRepos.length ? (
            <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
              {' '}· {workerRepos.join(', ')}
            </span>
          ) : null}
        </span>
      </div>
    );
  } else if (isAsking) {
    if (askListening) {
      body = (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            width: '100%',
            height: '100%',
            paddingLeft: 14,
            paddingRight: 14,
            overflow: 'hidden',
          }}
        >
          <div style={{ width: INNER_W, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <NotchWaveCanvas listening levelRef={levelRef} />
          </div>
        </div>
      );
    } else {
      // Chat continuity: pending rows render INSIDE the conversation. The You
      // turn carries the live transcript + a compact waveform while listening
      // (orbit + "Polishing…" after release); the Symon turn carries the
      // working orbit + live timer once the agent claims the transcript.
      const showPolish = panelPending && panelPending.phase !== 'listening' && !agentWorking;
      const pendingUser = panelPending
        ? {
            text: panelPending.text,
            visual: panelPending.phase === 'listening' ? (
              <div style={{ width: INNER_W, height: 22, display: 'flex', alignItems: 'center' }}>
                <NotchWaveCanvas listening levelRef={levelRef} />
              </div>
            ) : showPolish ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <NotchOrbit size={11} />
                <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'rgba(255, 255, 255, 0.6)' }}>
                  Polishing…
                </span>
              </div>
            ) : null,
          }
        : null;
      const pendingAssistant = agentWorking
        ? {
            visual: (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <NotchOrbit size={13} />
                <span style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'rgba(255, 255, 255, 0.9)' }}>
                  {agentTool === 'o8_ask' ? 'Synthesizing…' : 'Working…'}
                </span>
                {agentStartedAt ? <WorkingTimer startedAt={agentStartedAt} /> : null}
              </div>
            ),
          }
        : null;
      body = (
        <DockAskPanel
          thread={askThread}
          onClose={() => onCloseAsk?.()}
          pendingUser={pendingUser}
          pendingAssistant={pendingAssistant}
        />
      );
    }
  } else if (isSpeaking) {
    const playing = ttsState === 'playing';
    body = (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          width: '100%',
          height: '100%',
          paddingLeft: 14,
          paddingRight: 14,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '0.4px',
            textTransform: 'uppercase',
            color: 'rgba(255, 255, 255, 0.82)',
            textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'nowrap',
          }}
        >
          {playing ? 'Speaking' : 'Paused'}
        </span>
        <NotchSpeedSlider value={speechSpeed} onCommit={(v) => onSpeechSpeed?.(v)} />
        <NotchControlButton label={playing ? 'Pause' : 'Resume'} onClick={() => onTogglePause?.()}>
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </NotchControlButton>
        <NotchControlButton label="Stop" onClick={() => onStop?.()}>
          <StopGlyph />
        </NotchControlButton>
      </div>
    );
  } else if (mode === 'listening') {
    body = (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          width: '100%',
          height: '100%',
          paddingLeft: 14,
          paddingRight: 14,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: INNER_W, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NotchWaveCanvas listening levelRef={levelRef} />
        </div>
        {trimmedPartial ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: '#fff',
              textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              direction: 'rtl',
              textAlign: 'left',
            }}
            title={trimmedPartial}
          >
            <span style={{ direction: 'ltr', unicodeBidi: 'plaintext' } as React.CSSProperties}>{trimmedPartial}</span>
          </span>
        ) : null}
      </div>
    );
  } else if (mode === 'thinking') {
    body = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
        <NotchSquiggle />
      </div>
    );
  } else if (mode === 'done') {
    body = (
      <p
        style={{
          margin: 0,
          paddingLeft: 18,
          paddingRight: 18,
          fontSize: 13,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          color: '#fff',
          textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
          textAlign: 'center',
        }}
      >
        {isError
          ? (error ?? 'Dictation failed')
          : (pastedText && pastedText.trim().length > 0 ? pastedText.trim() : 'Pasted')}
      </p>
    );
  } else if (mode === 'idle' && workerCount > 0) {
    // Fleet visibility in the resting sliver. The spinning orbit means lanes
    // are genuinely WORKING; lanes parked on the operator show a static amber
    // dot instead — a paused packet must not read as active work. Dark ink —
    // the sliver surface is light in both dock themes (brand pastel / white
    // glass).
    const sliverInk = 'rgba(28, 28, 46, 0.8)';
    body = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, width: '100%', height: '100%' }}>
        {workerWorking > 0 ? (
          <NotchOrbit size={9} color="rgba(28, 28, 46, 0.78)" />
        ) : (
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'rgba(255, 159, 67, 0.95)',
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '0.2px',
            color: sliverInk,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {workerCount}
        </span>
      </div>
    );
  }

  // ── The ONE morphing notch dock element ──
  // Geometry transitions (width/height/border-radius/background/box-shadow) ARE
  // the morph: idle sliver ⇄ capsule ⇄ wide done, in place. Symon's spring.
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        pointerEvents: 'auto',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#f4f5f7',
        WebkitFontSmoothing: 'antialiased',
        borderStyle: 'solid',
        borderWidth: 1,
        borderTopWidth: 0,
        userSelect: 'none',
        ...geometry,
        transition:
          'width 0.5s cubic-bezier(0.22, 1, 0.36, 1),'
          + ' height 0.5s cubic-bezier(0.22, 1, 0.36, 1),'
          + ' border-radius 0.46s cubic-bezier(0.22, 1, 0.36, 1),'
          + ' background 0.4s ease,'
          + ' box-shadow 0.4s ease',
      } as React.CSSProperties}
    >
      {body}
      <style>{
        '@keyframes o8DockSquiggle { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -64; } }'
        + '@keyframes o8DockOrbit { to { transform: rotate(360deg); } }'
        + '@media (prefers-reduced-motion: reduce) { [style*="o8DockOrbit"] { animation: none !important; } }'
      }</style>
    </div>
  );
}
