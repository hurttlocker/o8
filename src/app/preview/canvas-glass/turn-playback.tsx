'use client';

/**
 * TurnPlaybackBar — Symon voice playback for a settled orchestrator turn.
 * Emitted once at the END of a turn (page.tsx 'ready' branch) carrying the
 * full assistant answer; clicking ▶ plays the whole thing back via the shared
 * `ttsEngine` (edge-tts Mister voice, SpeechSynthesis fallback). While this
 * turn is the active playback the row morphs into the transport — back 10s,
 * pause/resume, forward 10s, speed, time, stop — the same controls the default
 * IDE's MessageActions runs, in canvas glass tones (raw SVG, --cnv-* tokens).
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ttsEngine, type TTSEngineState } from '@/lib/tts/engine';
import { FONT } from './ui';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const RATES = [1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** A bare transport glyph button — boxless ink, like the composer's send
 *  arrow (no filled tint: --cnv-tint is near-white on a light canvas and would
 *  read as a clunky white blob). `primary` carries full ink for the main
 *  play/pause; the rest sit at muted weight and brighten to ink on hover. */
function TransportButton({
  label,
  onClick,
  children,
  primary = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 7,
        borderWidth: 0,
        background: 'transparent',
        color: primary ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = primary ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)'; }}
    >
      {children}
    </button>
  );
}

function PlayGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ display: 'block', width: size, height: size, flexShrink: 0 }}>
      <path d="M7 4l13 8-13 8z" />
    </svg>
  );
}

function PauseGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ display: 'block', width: size, height: size, flexShrink: 0 }}>
      <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
    </svg>
  );
}

export function TurnPlaybackBar({ text, messageId }: { text: string; messageId: string }) {
  const [tts, setTts] = useState<TTSEngineState>(() => ttsEngine.state);
  useEffect(() => ttsEngine.subscribe(setTts), []);

  const active = tts.activeMessageId === messageId;
  const loading = active && tts.state === 'loading';
  const playing = active && tts.state === 'playing';
  const transport = active && (tts.state === 'playing' || tts.state === 'paused' || tts.state === 'loading');

  // Settled (not this turn's playback) → the quiet ▶ that pops up at turn end.
  if (!transport) {
    return (
      <button
        type="button"
        aria-label="Play back the full response"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => { void ttsEngine.play(text, messageId); }}
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 4,
          paddingTop: 3,
          paddingBottom: 3,
          paddingLeft: 4,
          paddingRight: 8,
          borderWidth: 0,
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--cnv-ink-muted)',
          cursor: 'pointer',
          fontFamily: FONT,
          fontSize: 10.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
      >
        <PlayGlyph size={12} />
        Play response
      </button>
    );
  }

  // Active playback → the transport row.
  return (
    <div
      onPointerDown={(event) => event.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 5 }}
    >
      <TransportButton label="Back 10 seconds" onClick={() => ttsEngine.seekRelative(-10)}>
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block', width: 13, height: 13, flexShrink: 0 }}>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
        </svg>
      </TransportButton>

      <TransportButton label={playing ? 'Pause' : 'Resume'} primary onClick={() => (playing ? ttsEngine.pause() : ttsEngine.resume())}>
        {loading ? (
          <motion.span
            aria-hidden
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            style={{ display: 'inline-flex' }}
          >
            <PlayGlyph />
          </motion.span>
        ) : playing ? (
          <PauseGlyph />
        ) : (
          <PlayGlyph />
        )}
      </TransportButton>

      <TransportButton label="Forward 10 seconds" onClick={() => ttsEngine.seekRelative(10)}>
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block', width: 13, height: 13, flexShrink: 0 }}>
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
        </svg>
      </TransportButton>

      {/* Speed — cycles 1 → 1.25 → 1.5 → 2×. */}
      <button
        type="button"
        aria-label={`Playback speed ${tts.playbackRate}×`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => ttsEngine.setRate(RATES[(RATES.indexOf(tts.playbackRate) + 1) % RATES.length])}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 24,
          paddingLeft: 5,
          paddingRight: 5,
          borderWidth: 0,
          borderRadius: 7,
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: FONT,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '-0.1px',
          color: tts.playbackRate === 1 ? 'var(--cnv-ink-muted)' : 'var(--cnv-ink)',
          flexShrink: 0,
        }}
      >
        {tts.playbackRate}×
      </button>

      {/* Time. */}
      <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: MONO, letterSpacing: '-0.02em', marginLeft: 2, minWidth: 66, textAlign: 'center' }}>
        {formatTime(tts.currentTime)} / {formatTime(tts.duration)}
      </span>

      <TransportButton label="Stop playback" onClick={() => ttsEngine.stop()}>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ display: 'block', width: 11, height: 11, flexShrink: 0 }}>
          <rect x="5" y="5" width="14" height="14" rx="2.5" />
        </svg>
      </TransportButton>
    </div>
  );
}
