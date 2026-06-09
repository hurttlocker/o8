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
const GLASS_IDLE = 'linear-gradient(rgba(255,255,255,0.20), rgba(232,238,250,0.10))';
const GLASS_CAPSULE_BG = 'linear-gradient(rgba(20,24,34,0.52), rgba(14,18,28,0.46))';
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
  onAgentConfirm?: (taskId: string, allow: boolean) => void;
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
  onAgentConfirm,
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
  // should stay visible while its answer speaks.
  const isAsking = askOpen && dictationMode === 'idle';
  // While listening for the question (empty thread) the panel shows the compact
  // capsule + waveform; once an answer lands it's the full grown panel.
  const askListening = isAsking && askMode === 'listening' && askThread.length === 0;
  const mode = dictationMode;
  const isError = state === 'error';
  // Symon voice agent surfaces. A pending confirm wins over everything except a
  // real dictation (you can Left-Option talk over it). The working indicator
  // shows while the loop runs and nothing else owns the dock.
  const isConfirming = !!agentConfirm && dictationMode === 'idle';
  const isAgentWorking =
    agentWorking && !isConfirming && dictationMode === 'idle' && !isAsking && !isSpeaking;

  // Live ref for the canvas RAF loop (avoid re-running the effect per frame).
  const levelRef = useRef<number>(audioLevel);
  useEffect(() => { levelRef.current = audioLevel; }, [audioLevel]);

  // Dock theme (Theme tab → Dock). 'symon' = the multicolor brand surface,
  // 'glass' = clear/frosted. Shared-origin localStorage; tracks the storage event.
  const [dockTheme, setDockTheme] = useState<'symon' | 'glass'>('symon');
  useEffect(() => {
    const read = () => { try { setDockTheme(localStorage.getItem('o8:dock-theme') === 'glass' ? 'glass' : 'symon'); } catch { /* noop */ } };
    read();
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, []);
  const glassDock = dockTheme === 'glass';
  const idleBg = glassDock ? GLASS_IDLE : SYMON_IDLE_GRADIENT;
  const capsuleBg = glassDock ? GLASS_CAPSULE_BG : SYMON_CAPSULE_BG;
  const capsuleBlur: React.CSSProperties = glassDock ? GLASS_BLUR : {};

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
      // Answer panel — the full glass surface (the root width/height/radius
      // transition animates the 248→420 grow for free).
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
      // Speaking capsule — the darkened brand surface with the controls.
      return {
        width: 196,
        height: 40,
        borderRadius: '0 0 20px 20px',
        background: capsuleBg, ...capsuleBlur,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
      } as React.CSSProperties;
    }
    if (mode === 'idle') {
      return {
        width: 128,
        height: 16,
        borderRadius: '0 0 14px 14px',
        background: idleBg,
        borderColor: 'rgba(255, 255, 255, 0.45)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28), inset 0 -2px 6px rgba(120, 110, 160, 0.22)',
        backdropFilter: 'blur(10px) saturate(160%)',
        WebkitBackdropFilter: 'blur(10px) saturate(160%)',
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
  } else if (isAgentWorking) {
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
        <NotchSquiggle />
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
          Symon is working…
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
      body = <DockAskPanel thread={askThread} onClose={() => onCloseAsk?.()} />;
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
      }</style>
    </div>
  );
}
