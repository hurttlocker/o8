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

import { useEffect, useRef } from 'react';
import type { DictationSnapshot, DictationState } from './types';

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
}

/**
 * DockNotchSurface — the single morphing notch dock element.
 *
 * One `.ndock` element. Its geometry/background animate per state via the
 * Symon spring; the content inside swaps. idle ⇄ listening ⇄ thinking ⇄ done.
 */
export function DockNotchSurface({ snapshot, ttsState = 'idle', onTogglePause, onStop }: DockNotchSurfaceProps) {
  const { state, audioLevel, partialTranscript, error, pastedText } = snapshot;
  const dictationMode = modeFor(state);
  // The speaking capsule shows whenever TTS is playing/paused. It WINS over the
  // dictation morph: the TTS engine also emits `system-start` (which drives the
  // dictation 'recording' waveform) so without this override the controls would
  // be masked by the waveform during playback. Real dictation and TTS don't
  // overlap in practice, so letting speaking win is safe.
  const isSpeaking = ttsState === 'playing' || ttsState === 'paused';
  const mode = dictationMode;
  const isError = state === 'error';

  // Live ref for the canvas RAF loop (avoid re-running the effect per frame).
  const levelRef = useRef<number>(audioLevel);
  useEffect(() => { levelRef.current = audioLevel; }, [audioLevel]);

  const trimmedPartial = partialTranscript.trim();

  // ── Per-mode geometry (verbatim Symon NotchSurface dimensions) ──
  // idle: 128×16 sliver. listening/thinking: 248×40 capsule. done: 420×44 wide.
  const geometry: React.CSSProperties = (() => {
    if (isSpeaking) {
      // Speaking capsule — the darkened brand surface with the controls.
      return {
        width: 196,
        height: 40,
        borderRadius: '0 0 20px 20px',
        background: SYMON_CAPSULE_BG,
        borderColor: 'rgba(255, 255, 255, 0.4)',
        boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
      } as React.CSSProperties;
    }
    if (mode === 'idle') {
      return {
        width: 128,
        height: 16,
        borderRadius: '0 0 14px 14px',
        background: SYMON_IDLE_GRADIENT,
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
          : SYMON_CAPSULE_BG,
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
      background: SYMON_CAPSULE_BG,
      borderColor: 'rgba(255, 255, 255, 0.4)',
      boxShadow: '0 8px 22px rgba(40, 40, 80, 0.3)',
    } as React.CSSProperties;
  })();

  // ── Inner content per mode ──
  let body: React.ReactNode = null;
  if (isSpeaking) {
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
