'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from '../lucide-shims';
import type { DictationSnapshot, DictationState } from './types';

const JAKARTA_STACK = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_STACK = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

const BAR_COUNT = 18;
const BAR_WIDTH = 3;
const BAR_GAP = 3;
const INNER_H = 18;
const INNER_W = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP; // 105

const WEIGHTS = (() => {
  const out = new Array<number>(BAR_COUNT);
  const center = (BAR_COUNT - 1) / 2;
  for (let i = 0; i < BAR_COUNT; i++) {
    const dist = Math.abs(i - center) / center;
    out[i] = Math.exp(-1.8 * dist * dist);
  }
  return out;
})();

const GRADIENT_STOPS: Array<[number, string]> = [
  [0.00, 'rgba(136, 209, 241, 0.92)'],
  [0.42, 'rgba(177, 180, 229, 0.95)'],
  [0.72, 'rgba(245, 184, 196, 0.92)'],
  [1.00, 'rgba(244, 201, 119, 0.92)'],
];

const DOT_COLOR: Record<DictationState, string> = {
  'idle': 'transparent',
  'requesting-mic': '#ef4444',
  'recording': '#ef4444',
  'transcribing': '#f59e0b',
  'polishing': '#a78bfa',
  'success': '#16a34a',
  'error': '#ef4444',
};

function formatTimer(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function stateLabel(state: DictationState, error: string | null): string | null {
  if (state === 'transcribing') return 'transcribing';
  if (state === 'polishing') return 'polishing';
  if (state === 'success') return 'done';
  // Error: surface the full message so the user can read it. The pill
  // widens for error states (see pillWidth below) so it has room.
  if (state === 'error') return error ?? 'Mic error';
  return null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface DictationPillProps {
  snapshot: DictationSnapshot;
  onCancel: () => void;
  /** Element to anchor the pill above. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Override anchor: explicit (left, bottom) px from viewport bottom-left. */
  position?: { left: number; bottom: number };
}

interface AnchorPos { left: number; bottom: number }

export function DictationPill({ snapshot, onCancel, anchorRef, position }: DictationPillProps) {
  const { state, audioLevel, durationMs, error, partialTranscript } = snapshot;
  const visible = state !== 'idle';

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentLevelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const targetLevelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const rafRef = useRef<number | null>(null);
  const stateRef = useRef<DictationState>(state);
  const levelRef = useRef<number>(audioLevel);
  const [anchor, setAnchor] = useState<AnchorPos | null>(null);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { levelRef.current = audioLevel; }, [audioLevel]);

  // Compute pill width — grows with the partial transcript so spoken
  // words have room. Symon's design steps every ~3 words; we just clamp
  // to a max so the pill stays readable.
  const pillWidth = useMemo(() => {
    if (state === 'error') return 460;
    if (state === 'success') return 280;
    if (state === 'transcribing' || state === 'polishing') return 280;
    if (state === 'recording' && partialTranscript.trim().length > 0) {
      // ~7px per char + chrome (dot + waveform + timer + button) ≈ 200
      const estimated = 220 + Math.min(360, partialTranscript.length * 7);
      return Math.max(360, Math.min(640, Math.round(estimated / 8) * 8));
    }
    return 280;
  }, [state, partialTranscript]);

  // Compute anchor position whenever visible flips on or window resizes.
  useEffect(() => {
    if (!visible) {
      setAnchor(null);
      return;
    }
    if (position) {
      setAnchor(position);
      return;
    }
    const compute = () => {
      const el = anchorRef?.current;
      if (!el) {
        setAnchor({
          left: Math.max(8, Math.floor((window.innerWidth - pillWidth) / 2)),
          bottom: 24,
        });
        return;
      }
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const left = Math.min(
        Math.max(8, Math.floor(centerX - pillWidth / 2)),
        Math.max(8, window.innerWidth - pillWidth - 8),
      );
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);
      setAnchor({ left, bottom });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [visible, anchorRef, position, pillWidth]);

  // Canvas RAF loop — only while visible.
  useEffect(() => {
    if (!visible) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      currentLevelsRef.current = new Array(BAR_COUNT).fill(0);
      targetLevelsRef.current = new Array(BAR_COUNT).fill(0);
      return;
    }
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
      const s = stateRef.current;
      const lvl = levelRef.current;
      const speaking = lvl > 0.08;
      const listening = s === 'recording';
      const reduced = (s === 'transcribing' || s === 'polishing') ? 0.4 : 1;
      const ambientBase = speaking ? 0.22 : listening ? 0.18 : 0.12;

      const target = targetLevelsRef.current;
      const current = currentLevelsRef.current;

      for (let i = 0; i < BAR_COUNT; i++) {
        const phase = i * 0.42;
        const ambient = ambientBase + 0.08 * Math.sin(t * (speaking ? 6 : 2.2) + phase);
        const level = Math.max(0, Math.min(1, lvl * reduced));
        const driven = (speaking || listening) ? level : 0;
        const amp = Math.max(ambient, driven * WEIGHTS[i]) + driven * 0.08 * Math.sin(t * 12 + phase);
        target[i] = Math.max(0.04, Math.min(1, amp));
      }

      const smoothing = speaking ? 0.36 : 0.22;
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
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [visible]);

  const label = useMemo(() => stateLabel(state, error), [state, error]);

  if (!visible || typeof document === 'undefined') return null;
  if (!anchor) return null;

  const dotColor = DOT_COLOR[state] ?? '#ef4444';
  const pulseDot = state === 'recording' || state === 'requesting-mic';
  const isError = state === 'error';
  const isRecording = state === 'recording' || state === 'requesting-mic';
  const trimmedPartial = partialTranscript.trim();

  const dot = (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 9999,
        background: dotColor,
        boxShadow: pulseDot ? `0 0 0 0 ${dotColor}55` : 'none',
        animation: pulseDot ? 'o8DictPulse 1.4s ease-out infinite' : 'none',
        flexShrink: 0,
      } as React.CSSProperties}
    />
  );
  const cancelButton = (
    <button
      type="button"
      onClick={onCancel}
      aria-label="Cancel dictation"
      style={{
        width: 22,
        height: 22,
        borderRadius: 9999,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <X size={12} />
    </button>
  );

  // Layout per state.
  // - recording: dot · waveform · partial-text (flex-1, scrolls right) · timer · ×
  // - transcribing/polishing/success: dot · centered label · ×
  // - error: dot · centered error message · ×
  let body: React.ReactNode;
  if (isRecording) {
    body = (
      <>
        {dot}
        <canvas
          ref={canvasRef}
          width={INNER_W}
          height={INNER_H}
          style={{ width: INNER_W, height: INNER_H, display: 'block', flexShrink: 0 }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            color: 'var(--t-text)',
            letterSpacing: '-0.005em',
            lineHeight: 1.35,
            // Right-align text so newest words sit next to the timer
            // (left-aligned would push the most recent words off-screen).
            direction: 'ltr',
            textAlign: 'left',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            opacity: trimmedPartial ? 1 : 0.45,
          }}
          title={trimmedPartial}
        >
          {trimmedPartial || 'Listening…'}
        </span>
        <span
          style={{
            fontFamily: MONO_STACK,
            fontSize: 11,
            color: 'var(--t-text-muted)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {formatTimer(durationMs)}
        </span>
        {cancelButton}
      </>
    );
  } else {
    // Centered label for transcribing / polishing / success / error.
    body = (
      <>
        {dot}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'center',
            fontSize: isError ? 12 : 12.5,
            fontWeight: isError ? 500 : 400,
            color: isError ? '#ef4444' : 'var(--t-text)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            // Compensate for the dot+button on the sides so the text
            // visually centers on the pill axis (10 + 8 + 22 + 8 ≈ 48
            // on the right; left has dot + 10 gap; pulling left by 12px
            // balances).
            paddingLeft: 0,
            paddingRight: 12,
          }}
          title={label ?? ''}
        >
          {label ?? ''}
        </span>
        {cancelButton}
      </>
    );
  }

  const pillNode = (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: anchor.left,
        bottom: anchor.bottom,
        width: pillWidth,
        height: 58,
        borderRadius: 29,
        background: isError ? 'rgba(239, 68, 68, 0.08)' : 'var(--t-panel-solid, #ffffff)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: isError ? '#ef4444' : 'var(--t-border)',
        boxShadow: isError ? '0 16px 40px rgba(239, 68, 68, 0.22)' : '0 16px 40px rgba(15, 23, 42, 0.18)',
        paddingTop: 6,
        paddingRight: 8,
        paddingBottom: 6,
        paddingLeft: 14,
        backdropFilter: 'saturate(140%) blur(18px)',
        WebkitBackdropFilter: 'saturate(140%) blur(18px)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: JAKARTA_STACK,
        zIndex: 2147483600,
        userSelect: 'none',
        transition: 'width 160ms cubic-bezier(0.22, 1, 0.36, 1)',
      } as React.CSSProperties}
    >
      {body}
      <style>{'@keyframes o8DictPulse { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.45);} 70% { box-shadow: 0 0 0 8px rgba(239,68,68,0);} 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0);} }'}</style>
    </div>
  );

  return createPortal(pillNode, document.body);
}
