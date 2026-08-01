'use client';

import { useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';

const FONT = 'var(--font-sans-system)';

// The canonical status vocabulary — one row per state the app actually uses,
// so colors + motion can be locked in one place and rolled out everywhere
// (dots, banners, pills). Colors mirror AgentStatusDot; edit here + there
// together when tuning. (Q, 2026-07-11.)
const STATUS_STATES: Array<{
  state: AgentDotState;
  label: string;
  meaning: string;
  color: string;
  motion: string;
  where: string;
}> = [
  { state: 'idle', label: 'Idle', meaning: 'Present, not working. No claim on attention.', color: 'var(--t-text-faint)', motion: 'static ring', where: 'queued / archived rows' },
  { state: 'running', label: 'Working', meaning: 'Actively working. The 3×3 canvas breathes — center vs ring in anti-phase sine.', color: 'var(--t-accent)', motion: 'Breathe', where: 'live agents, streaming turns' },
  { state: 'review', label: 'Awaiting review', meaning: 'Paused, parked waiting on you. Neutral — the grid holds dim, the lit center blinks off rarely ("your turn"), not the color.', color: '#94a3b8', motion: 'Hold-blink', where: 'needs-review packets' },
  { state: 'rejected', label: 'Review declined', meaning: 'Reviewed and turned down. Gravity in amber — the 8 outer cells fall and fade, then reassemble. Same mark as failed; color is severity.', color: '#F97316', motion: 'Gravity (amber)', where: 'rejected packets' },
  { state: 'merged', label: 'Merged / done', meaning: 'Landed on main. Closed. Cells settle — pop in staggered and hold most of the cycle.', color: 'var(--t-success)', motion: 'Settle', where: 'released packets' },
  { state: 'failed', label: 'Failed', meaning: 'Crashed or errored out. Gravity in red — same fall-and-reassemble mark as a declined review, color raised to alarm.', color: '#FF3B30', motion: 'Gravity (red)', where: 'failed / blocked lanes' },
];

const SAMPLE_ROW_TITLE = 'Ingest spec files to improve retrieval awareness';
const SAMPLE_ROW_META = 'main · automation · idle';

// Neo-retro pixel-grid loaders — blocky pixel cells that flick on/off in
// discrete steps(). Each maps to one mechanic; CSS lives in
// globals.css as .o8-loader-<kind>. (2026-07-11.)
type LoaderKind = 'bitfield' | 'dispatch' | 'aurora' | 'mirror' | 'stack';
const LOADERS: Array<{ kind: LoaderKind; title: string; mechanic: string }> = [
  { kind: 'bitfield', title: 'Bitfield', mechanic: 'A lit pulse marches a 3×3 grid diagonally in hard steps(1) snaps — grid-based shape-shifting (cells on/off, not a rotating asset).' },
  { kind: 'dispatch', title: 'Dispatch', mechanic: 'A packed core spreads its 4 arms to a cross, then re-packs — the reference’s "posting" metaphor (data packed → data sent). Transform + opacity.' },
  { kind: 'aurora', title: 'Aurora', mechanic: 'A sharp stepping pixel quad over a soft drifting glow — the signature lo-fi/hi-fi contrast. Glow rasterizes once, only translates.' },
  { kind: 'mirror', title: 'Mirror', mechanic: 'Two diagonals of a 2×2 quad hard-swap opacity — the retro 2-frame "thinking" mirror/rotation, stepped.' },
  { kind: 'stack', title: 'Stack', mechanic: 'Four bar heights jump in quantized steps(4) scaleY — blocky frame-by-frame VU bounce, no smooth interpolation.' },
];

// Awaiting-review candidates — calm grey, patient cadences (2.4-3.2s), meant to
// replace the shipping grey sweep. CSS lives in globals.css as .o8-rev-<kind>.
// Lab-only until the operator locks one. (Claude, 2026-07-12.)
type ReviewKind = 'metronome' | 'hourglass' | 'blink' | 'queue' | 'frame';
const REVIEW_CANDIDATES: Array<{ kind: ReviewKind; cells: number; title: string; mechanic: string }> = [
  { kind: 'metronome', cells: 3, title: 'Metronome', mechanic: 'A lit cell ping-pongs across three — a patient tick' },
  { kind: 'hourglass', cells: 4, title: 'Hourglass', mechanic: 'Weight transfers top row → bottom row in hard steps' },
  { kind: 'blink', cells: 1, title: 'Blink', mechanic: 'Filled square holds, blinks off once, refills — an eye watching' },
  { kind: 'queue', cells: 3, title: 'Queue', mechanic: 'A marker advances to the front and dwells — you are next' },
  { kind: 'frame', cells: 3, title: 'Frame', mechanic: 'Brackets nudge in around a held dot — under review, framed' },
];

// Awaiting-review — ROUND 2. Every candidate is built on the EXACT AgentStatusDot
// 3×3 nine-cell grid (.o8-rev2 mirrors .o8-fam geometry — 3px cells, 1px gap,
// 11px footprint) so whichever the operator locks drops straight into the
// component. Calm grey, patient cadences, opacity-only. CSS in globals.css as
// .o8-rev2-<kind>. Lab-only. (Claude, 2026-07-12.)
type Rev2Kind =
  | 'held'
  | 'center'
  | 'cursor'
  | 'hourglass'
  | 'check'
  | 'checker'
  | 'lookup'
  | 'pause'
  | 'drop'
  | 'knock';
const REVIEW2_CANDIDATES: Array<{ kind: Rev2Kind; title: string; mechanic: string }> = [
  { kind: 'held', title: 'Held frame', mechanic: 'All nine cells rest at a calm dim; the top-left corner blinks off once every 3.4s — a parked frame with a slow tick.' },
  { kind: 'center', title: 'Center breath', mechanic: 'The eight outer cells hold faint while the center cell alone breathes very slowly (2.8s) — one eye open, waiting on you.' },
  { kind: 'cursor', title: 'Reading cursor', mechanic: 'The perimeter holds lit; a single brighter cell steps around the ring one position per beat — scanning, parked on your turn.' },
  { kind: 'hourglass', title: 'Hourglass', mechanic: 'Rows drain top → middle → bottom in hard steps, then all reset — sand settling, time held.' },
  { kind: 'check', title: 'Checkmark', mechanic: 'A tick-shaped subset of cells holds dim and pulses up together once per 3s cycle — an approval waiting to be given.' },
  { kind: 'checker', title: 'Checkerboard', mechanic: 'Alternating cells cross-fade against their opposites at a glacial 3.5s — a slow held swap, nothing rushing.' },
  { kind: 'lookup', title: 'Look-up', mechanic: 'All nine hold lit together, then blink off in unison once every 3s — the whole object glancing up at you.' },
  { kind: 'pause', title: 'Pause bars', mechanic: 'The two outer columns hold with a faint synchronized shimmer, middle column dark — the pause glyph, parked.' },
  { kind: 'drop', title: 'One drops', mechanic: 'The grid holds; a single cell dips out and restores per beat, wandering the positions — a slow idle fidget while it waits.' },
  { kind: 'knock', title: 'Knock', mechanic: 'The outer ring holds faint while the center double-pulses ("knock-knock") once per 3.2s — a patient tap on the glass.' },
];

export default function MotionPreviewPage() {
  const [showFocused, setShowFocused] = useState(true);

  return (
    <div
      style={{
        // The raw /preview route isn't wrapped in ThemeProvider, so var(--t-*)
        // tokens resolve to nothing and theme-token dots (working/merged/idle)
        // render blank. Seed the light-palette values here so the board shows
        // TRUE colors — otherwise it lies about the palette. (Q, 2026-07-11.)
        '--t-text-faint': '#94a3b8',
        '--t-accent': '#2563eb',
        // o8's single orange accent — the loaders below use it for lit pixels.
        '--t-loader': '#F97316',
        '--t-success': '#16a34a',
        '--t-bg-card': '#ffffff',
        '--t-divider': '#e5e7eb',
        minHeight: '100vh',
        background: 'var(--t-bg, #f8f8f6)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT,
        paddingTop: 40,
        paddingBottom: 80,
        paddingLeft: 40,
        paddingRight: 40,
      } as CSSProperties}
    >
      <header style={{ maxWidth: 920, margin: '0 auto', marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>
          Motion lab
        </h1>
        <p style={{ fontSize: 13, color: 'var(--t-text-muted, #6b7280)', marginTop: 6, lineHeight: 1.5, maxWidth: 640 }}>
          Loading / working indicators side-by-side. Picking one for the chat-row &quot;agent working&quot; pattern. <strong>3-dot pulse</strong> is currently the working choice (lives in <code>globals.css</code> as <code>.o8-dot-shimmer</code>). Hit the toggle below to compare the row with / without a focused-state title shimmer.
        </p>
        <button
          type="button"
          onClick={() => setShowFocused((v) => !v)}
          style={{
            marginTop: 12,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 12,
            paddingRight: 12,
            fontSize: 12,
            fontWeight: 440,
            letterSpacing: '-0.1px',
            borderRadius: 6,
            border: '1px solid var(--t-divider, #e5e7eb)',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: FONT,
            color: 'var(--t-text)',
          }}
        >
          {showFocused ? 'Hide' : 'Show'} focused row example
        </button>
      </header>

      {/* Status vocabulary — every state's color + motion in one board. This is
          the canonical reference to lock the palette across the app. */}
      <section style={{ maxWidth: 920, margin: '0 auto 40px auto' }}>
        <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Status vocabulary — colors &amp; states
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--t-text-muted)', margin: 0, marginBottom: 16, lineHeight: 1.5, maxWidth: 640 }}>
          Every status the app renders, at real size and enlarged. One place to lock the color + motion per state, then roll it out to dots, banners, and pills. Working is the orb; the rest are the ones to sharpen.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {STATUS_STATES.map((s) => (
            <div
              key={s.state}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: 16,
                borderRadius: 12,
                border: '1px solid var(--t-divider, #e5e7eb)',
                background: 'var(--t-bg-card, #ffffff)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {/* enlarged preview (3×) so motion + hue read clearly */}
                <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{ transform: 'scale(3)', transformOrigin: 'center' }}>
                    <AgentStatusDot state={s.state} />
                  </div>
                </div>
                {/* real size (7px), how it actually appears in a row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AgentStatusDot state={s.state} />
                  <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', letterSpacing: '-0.2px' }}>real</span>
                </div>
                <span
                  style={{
                    marginLeft: 'auto',
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: s.color,
                    flexShrink: 0,
                    border: '1px solid rgba(0,0,0,0.08)',
                  }}
                  title={s.color}
                />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.1px' }}>{s.label}</div>
                <div style={{ fontSize: 10.5, color: 'var(--t-text-faint)', marginTop: 2, fontFamily: 'var(--font-mono, monospace)' }}>
                  {s.state} · {s.motion} · {s.color}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>{s.meaning}</div>
              <div style={{ fontSize: 10.5, color: 'var(--t-text-faint)', marginTop: 'auto', paddingTop: 4 }}>{s.where}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Loaders — neo-retro pixel grid: low-fi cells flicking on/off in
          discrete steps(), one variant paired with a smooth hi-fi glow.
          All compositor-only (transform/opacity). */}
      <section style={{ maxWidth: 920, margin: '0 auto 40px auto' }}>
        <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Loaders — neo-retro pixel grid
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--t-text-muted)', margin: 0, marginBottom: 16, lineHeight: 1.5, maxWidth: 660 }}>
          Blocky pixel cells that flick on/off in discrete <code>steps()</code>, one paired with a lo-fi/hi-fi glow contrast that reads premium. o8 geometry + the single orange accent. Each is shown at its <strong>chrome size</strong> (~16px, where it&apos;d live in a row/composer) and enlarged 3×. Compositor-only — transform + opacity, no per-frame raster.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {LOADERS.map((l) => (
            <div
              key={l.kind}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 16,
                borderRadius: 12,
                border: '1px solid var(--t-divider, #e5e7eb)',
                background: 'var(--t-bg-card, #ffffff)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, minHeight: 52 }}>
                {/* enlarged 3× so the mechanic reads clearly */}
                <div style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{ transform: 'scale(3)', transformOrigin: 'center' }}>
                    <PixelLoader kind={l.kind} />
                  </div>
                </div>
                {/* chrome size (~16px), how it actually appears in a row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PixelLoader kind={l.kind} />
                  <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', letterSpacing: '-0.2px' }}>chrome</span>
                </div>
                {/* in a live row — pixel + working title */}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <PixelLoader kind={l.kind} />
                  <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--t-text)', whiteSpace: 'nowrap' }}>working…</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.1px' }}>{l.title}</div>
                <div style={{ fontSize: 10.5, color: 'var(--t-text-faint)', marginTop: 2, fontFamily: 'var(--font-mono, monospace)' }}>
                  .o8-loader-{l.kind}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>{l.mechanic}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Awaiting review — 5 candidates to replace the shipping grey sweep.
          Calm, patient, stepped grey. Lab-only until the operator locks one. */}
      <section style={{ maxWidth: 920, margin: '0 auto 40px auto' }}>
        <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Awaiting review — 5 candidates
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--t-text-muted)', margin: 0, marginBottom: 16, lineHeight: 1.5, maxWidth: 660 }}>
          Candidates to replace the grey sweep — calm, patient, waiting on a human. Current sweep keeps shipping until one is locked.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {REVIEW_CANDIDATES.map((c) => (
            <div
              key={c.kind}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 16,
                borderRadius: 12,
                border: '1px solid var(--t-divider, #e5e7eb)',
                background: 'var(--t-bg-card, #ffffff)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, minHeight: 52 }}>
                {/* enlarged 3× so the cadence reads clearly */}
                <div style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{ transform: 'scale(3)', transformOrigin: 'center' }}>
                    <ReviewCandidate kind={c.kind} cells={c.cells} />
                  </div>
                </div>
                {/* chrome size (~16px), how it actually appears in a row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ReviewCandidate kind={c.kind} cells={c.cells} />
                  <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', letterSpacing: '-0.2px' }}>chrome</span>
                </div>
                {/* in a live row — mark + review label */}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <ReviewCandidate kind={c.kind} cells={c.cells} />
                  <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--t-text)', whiteSpace: 'nowrap' }}>review ready</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.1px' }}>{c.title}</div>
                <div style={{ fontSize: 10.5, color: 'var(--t-text-faint)', marginTop: 2, fontFamily: 'var(--font-mono, monospace)' }}>
                  .o8-rev-{c.kind}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>{c.mechanic}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Awaiting review — ROUND 2. 10 candidates, every one on the real
          AgentStatusDot 3×3 nine-cell grid so the winner drops straight into the
          component. Calm grey, patient, opacity-only. */}
      <section style={{ maxWidth: 920, margin: '0 auto 40px auto' }}>
        <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Awaiting review — round 2 (10 candidates, 3×3)
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--t-text-muted)', margin: 0, marginBottom: 16, lineHeight: 1.5, maxWidth: 660 }}>
          Ten fresh review mechanics, every one built on the <strong>exact AgentStatusDot nine-cell 3×3 grid</strong> (same cell size, gap, and footprint as the shipping family) so whichever you lock drops straight into the component. Calm grey, patient cadence (2.8–5.4s) — &quot;paused, parked, your turn,&quot; clearly distinct from working (Breathe) and idle (Drift). Shown enlarged 3×, at real size, and in a live row.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {REVIEW2_CANDIDATES.map((c) => (
            <div
              key={c.kind}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 16,
                borderRadius: 12,
                border: '1px solid var(--t-divider, #e5e7eb)',
                background: 'var(--t-bg-card, #ffffff)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, minHeight: 52 }}>
                {/* enlarged 3× so the cadence reads clearly */}
                <div style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{ transform: 'scale(3)', transformOrigin: 'center' }}>
                    <Review2Candidate kind={c.kind} />
                  </div>
                </div>
                {/* real size (11px), how it actually appears in a row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Review2Candidate kind={c.kind} />
                  <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', letterSpacing: '-0.2px' }}>real</span>
                </div>
                {/* in a live row — mark + review label */}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <Review2Candidate kind={c.kind} />
                  <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--t-text)', whiteSpace: 'nowrap' }}>review ready</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.1px' }}>{c.title}</div>
                <div style={{ fontSize: 10.5, color: 'var(--t-text-faint)', marginTop: 2, fontFamily: 'var(--font-mono, monospace)' }}>
                  .o8-rev2-{c.kind}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>{c.mechanic}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Applied vocabulary — each motion in its proposed surface */}
      <section style={{ maxWidth: 920, margin: '0 auto 36px auto' }}>
        <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Applied — motion vocabulary in context
        </h2>
        <p style={{ fontSize: 12, color: 'var(--t-text-muted)', marginBottom: 16, maxWidth: 640, lineHeight: 1.5 }}>
          Three motion roles. A is <strong>static</strong> (state), B + C are <strong>animated</strong> (action). Same shape language across A and B — frozen 3-dot says &quot;available&quot;, animated 3-dot says &quot;working&quot;.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {/* A. Static outline ring → session pill */}
          <AppliedCard
            label="A. Static outline ring"
            role={<>State: <strong>alive, quiet</strong></>}
            surface="Session pill (SessionVisualizer)"
            notes="Hollow circle, no animation. Says: 'session is here, no work right now.' Reads as a status dot without claiming attention."
          >
            <MockSessionPillStatic />
          </AppliedCard>

          {/* B. Single pulsing circle → chat row working */}
          <AppliedCard
            label="B. Single pulsing circle"
            role={<>Action: <strong>working now</strong></>}
            surface="Chat row"
            notes="Solid circle, breathing. Says: 'agent is producing output for this chat right now.' Filled vs hollow distinguishes from A."
          >
            <MockChatRowWorking />
          </AppliedCard>

          {/* C. Binary orbit → mission progress */}
          <AppliedCard
            label="C. Binary orbit"
            role={<>Action: <strong>in flow</strong></>}
            surface="Mission progress card"
            notes="Two dots orbiting a center. Says: 'long-running op underway.' Sustained motion reads as continuous flow."
          >
            <MockMissionCard />
          </AppliedCard>
        </div>

        {/* A alternates — operator picks which static "quiet" reads best */}
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--t-divider, #e5e7eb)',
          }}
        >
          <h3 style={{ fontSize: 12.5, fontWeight: 440, letterSpacing: '-0.1px', margin: 0, marginBottom: 4, color: 'var(--t-text)' }}>
            A — quiet-state candidates
          </h3>
          <p style={{ fontSize: 11.5, color: 'var(--t-text-muted)', marginBottom: 12, maxWidth: 560, lineHeight: 1.45 }}>
            All static, no animation. Pick which &quot;available but doing nothing&quot; reads cleanest next to the animated B and C.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            <QuietCard label="A1 — static 3-dot (recommended)">
              <StaticThreeDot />
              <SampleText muted>idle session</SampleText>
            </QuietCard>
            <QuietCard label="A2 — single faint dot">
              <StaticSingleDot />
              <SampleText muted>idle session</SampleText>
            </QuietCard>
            <QuietCard label="A3 — outline circle (ring)">
              <StaticRing />
              <SampleText muted>idle session</SampleText>
            </QuietCard>
            <QuietCard label="A4 — thin dash">
              <StaticDash />
              <SampleText muted>idle session</SampleText>
            </QuietCard>
          </div>
        </div>
      </section>

      <hr
        style={{
          maxWidth: 920,
          margin: '0 auto 24px auto',
          border: 'none',
          borderTop: '1px solid var(--t-divider, #e5e7eb)',
        }}
      />

      <h2 style={{ maxWidth: 920, margin: '0 auto 12px auto', fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px' }}>
        All motion options (raw)
      </h2>
      <div
        style={{
          maxWidth: 920,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16,
        }}
      >
        <MotionCard
          name="3-dot pulse (current pick)"
          description="Three small dots, staggered fade. Lives in globals.css. Used for agent-working state in chat rows."
        >
          <span className="o8-dot-shimmer" style={{ marginRight: 8 }}>
            <span />
            <span />
            <span />
          </span>
          <SampleText muted>{SAMPLE_ROW_TITLE}</SampleText>
        </MotionCard>

        <MotionCard
          name="Single pulsing circle"
          description="One filled circle that breathes. Reads as a status indicator more than a loader."
        >
          <PulsingCircle />
          <SampleText muted>{SAMPLE_ROW_TITLE}</SampleText>
        </MotionCard>

        <MotionCard
          name="Spinning ring"
          description="Classic loader. Reads as 'request in flight' more than 'long-running task'."
        >
          <SpinningRing />
          <SampleText muted>{SAMPLE_ROW_TITLE}</SampleText>
        </MotionCard>

        <MotionCard
          name="Wave bar"
          description="Three vertical bars, height oscillating. Reads as audio / activity."
        >
          <WaveBar />
          <SampleText muted>{SAMPLE_ROW_TITLE}</SampleText>
        </MotionCard>

        <MotionCard
          name="Orbit (1 dot circling)"
          description="A dot tracing a small circle. Subtle, reads as 'cycling work'."
        >
          <OrbitDot />
          <SampleText muted>{SAMPLE_ROW_TITLE}</SampleText>
        </MotionCard>

        <MotionCard
          name="Gradient sweep across icon slot"
          description="A vertical bar swept by a gradient. Could substitute for a row icon."
        >
          <GradientSweep />
          <SampleText muted>{SAMPLE_ROW_TITLE}</SampleText>
        </MotionCard>
      </div>

      <hr
        style={{
          maxWidth: 920,
          margin: '40px auto 24px auto',
          border: 'none',
          borderTop: '1px solid var(--t-divider, #e5e7eb)',
        }}
      />

      {/* Pulse + ∞ variants — riffs on the single pulsing circle base.
          Each layers an infinity / "o8" / figure-8 motif over the pulse. */}
      <section style={{ maxWidth: 920, margin: '0 auto 32px auto' }}>
        <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 6 }}>
          Pulse + ∞ variants
        </h2>
        <p style={{ fontSize: 12, color: 'var(--t-text-muted)', marginBottom: 16, maxWidth: 600, lineHeight: 1.5 }}>
          Operator likes the single pulsing circle. These are 5 riffs layering an infinity / 8 / o8 motif. Pick one as the brand loader; the rest stay in the lab for reference.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
          }}
        >
          <MotionCard
            name="Base — single pulsing circle"
            description="The dialed-in baseline. One filled circle breathing."
          >
            <PulsingCircle />
            <SampleText muted>working...</SampleText>
          </MotionCard>

          <MotionCard
            name="o8 dual pulse"
            description='Small + large circles side-by-side, pulsing offset. Literal "o8" mark.'
          >
            <O8DualPulse />
            <SampleText muted>working...</SampleText>
          </MotionCard>

          <MotionCard
            name="∞ figure-8 trace"
            description="One dot tracing the lemniscate path. Reads as continuous flow."
          >
            <InfinityDotTrace />
            <SampleText muted>working...</SampleText>
          </MotionCard>

          <MotionCard
            name="∞ stroke draw"
            description="The infinity outline drawing itself in via stroke-dashoffset."
          >
            <InfinityStrokeDraw />
            <SampleText muted>working...</SampleText>
          </MotionCard>

          <MotionCard
            name="Pulsing ∞ glyph"
            description="The character ∞ breathing. Lightest implementation; reads as text-level."
          >
            <PulsingInfinityGlyph />
            <SampleText muted>working...</SampleText>
          </MotionCard>

          <MotionCard
            name="Binary orbit"
            description="Two dots orbiting a center 180° apart. Hints at a figure-8 when watched."
          >
            <BinaryOrbit />
            <SampleText muted>working...</SampleText>
          </MotionCard>
        </div>
      </section>

      <hr
        style={{
          maxWidth: 920,
          margin: '0 auto 24px auto',
          border: 'none',
          borderTop: '1px solid var(--t-divider, #e5e7eb)',
        }}
      />

      {showFocused ? (
        <section style={{ maxWidth: 920, margin: '0 auto' }}>
          <h2 style={{ fontSize: 14, fontWeight: 440, letterSpacing: '-0.2px', margin: 0, marginBottom: 12 }}>
            Focused-row title shimmer (light gray)
          </h2>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', marginBottom: 16, maxWidth: 560, lineHeight: 1.5 }}>
            The title shimmer kicks in only when the row is the focused/active chat. Color changed from blue accent to <code>var(--t-text-faint)</code> per the locked theme spec.
          </p>
          <div
            style={{
              background: 'var(--t-panel, #ffffff)',
              border: '1px solid var(--t-divider, #e5e7eb)',
              borderRadius: 10,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              maxWidth: 420,
            }}
          >
            <RowExample focused workingShimmer={false} title="Focused chat (no agent work)" meta={SAMPLE_ROW_META} />
            <RowExample focused workingShimmer title="Focused + agent working" meta={SAMPLE_ROW_META} />
            <RowExample focused={false} workingShimmer title="Not focused, agent working" meta={SAMPLE_ROW_META} />
            <RowExample focused={false} workingShimmer={false} title="Idle row, no state" meta={SAMPLE_ROW_META} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MotionCard({
  name,
  description,
  children,
}: {
  name: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--t-panel, #ffffff)',
        border: '1px solid var(--t-divider, #e5e7eb)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 24 }}>
        {children}
      </div>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 440, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
          {name}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.45, marginTop: 3 }}>
          {description}
        </div>
      </div>
    </div>
  );
}

function SampleText({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      style={{
        flex: 1,
        fontSize: 13.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: 1.25,
        color: muted ? 'var(--t-text)' : 'var(--t-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// Renders one neo-retro pixel loader by kind. Cell counts match the CSS
// nth-child rules in globals.css (.o8-loader-<kind>).
function PixelLoader({ kind }: { kind: LoaderKind }) {
  const cells: Record<LoaderKind, number> = {
    bitfield: 9,
    dispatch: 5,
    aurora: 4,
    mirror: 4,
    stack: 4,
  };
  return (
    <span className={`o8-loader-${kind}`} aria-hidden>
      {Array.from({ length: cells[kind] }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

// Renders one awaiting-review candidate by kind. Cell counts match the CSS
// nth-child rules in globals.css (.o8-rev-<kind>).
function ReviewCandidate({ kind, cells }: { kind: ReviewKind; cells: number }) {
  return (
    <span className={`o8-rev-${kind}`} aria-hidden>
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

// Renders one round-2 review candidate — always nine cells on the real
// AgentStatusDot 3×3 grid (.o8-rev2 mirrors .o8-fam geometry). The variant class
// drives the opacity choreography; CSS lives in globals.css (.o8-rev2-<kind>).
function Review2Candidate({ kind }: { kind: Rev2Kind }) {
  return (
    <span className={`o8-rev2 rev2-${kind}`} aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

function PulsingCircle() {
  return (
    <motion.span
      style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)', flexShrink: 0 }}
      animate={{ opacity: [0.35, 1, 0.35], scale: [0.85, 1.1, 0.85] }}
      transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
    />
  );
}

function SpinningRing() {
  return (
    <motion.span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '1.5px solid var(--t-text-faint, #9ca3af)',
        borderTopColor: 'transparent',
        flexShrink: 0,
        display: 'inline-block',
      }}
      animate={{ rotate: 360 }}
      transition={{ duration: 1.05, ease: 'linear', repeat: Infinity }}
    />
  );
}

function WaveBar() {
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center', height: 12, flexShrink: 0 }}>
      {[0, 0.2, 0.4].map((delay) => (
        <motion.span
          key={delay}
          style={{ width: 2, background: 'var(--t-text-faint, #9ca3af)', borderRadius: 1, display: 'inline-block' }}
          animate={{ height: [3, 12, 3] }}
          transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut', delay }}
        />
      ))}
    </span>
  );
}

function OrbitDot() {
  return (
    <span style={{ position: 'relative', width: 14, height: 14, flexShrink: 0, display: 'inline-block' }}>
      <motion.span
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          marginLeft: -2,
          width: 4,
          height: 4,
          borderRadius: '50%',
          background: 'var(--t-text-faint, #9ca3af)',
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 1.8, ease: 'linear', repeat: Infinity }}
        // motion-style: rotate around center via transform-origin
      />
      <span
        aria-hidden
        style={{
          position: 'absolute',
          inset: 1,
          borderRadius: '50%',
          border: '1px solid var(--t-text-faint, #9ca3af)',
          opacity: 0.2,
        }}
      />
    </span>
  );
}

function GradientSweep() {
  return (
    <span
      style={{
        position: 'relative',
        width: 14,
        height: 14,
        overflow: 'hidden',
        flexShrink: 0,
        display: 'inline-block',
        borderRadius: 3,
      }}
    >
      <motion.span
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, transparent 0%, var(--t-text-faint, #9ca3af) 50%, transparent 100%)',
        }}
        animate={{ y: ['-100%', '100%'] }}
        transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
      />
    </span>
  );
}

// ── Applied vocabulary mocks ───────────────────────────────────────

function AppliedCard({
  label,
  role,
  surface,
  notes,
  children,
}: {
  label: string;
  role: React.ReactNode;
  surface: string;
  notes: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--t-panel, #ffffff)',
        border: '1px solid var(--t-divider, #e5e7eb)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          minHeight: 64,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--t-bg, #fafafa)',
          border: '1px solid var(--t-divider-subtle, #f0f0f0)',
          borderRadius: 8,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 10,
          paddingRight: 10,
        }}
      >
        {children}
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--t-text-faint)', letterSpacing: '-0.1px', marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 440, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
          {role}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', marginTop: 4, fontStyle: 'italic' }}>
          {surface}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.45, marginTop: 6 }}>
          {notes}
        </div>
      </div>
    </div>
  );
}

function MockSessionPillStatic() {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 9,
        paddingRight: 11,
        borderRadius: 8,
        border: '1px solid var(--t-divider, #e5e7eb)',
        background: 'var(--t-panel, #ffffff)',
        fontFamily: FONT,
      }}
    >
      <StaticRing />
      <span
        style={{
          fontSize: 12,
          fontWeight: 440,
          letterSpacing: '-0.1px',
          color: 'var(--t-text)',
        }}
      >
        codex · main
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 260,
          letterSpacing: '-0.4px',
          color: 'var(--t-text-faint)',
        }}
      >
        idle
      </span>
    </div>
  );
}

function QuietCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--t-panel, #ffffff)',
        border: '1px solid var(--t-divider, #e5e7eb)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 }}>
        {children}
      </div>
      <div style={{ fontSize: 11, color: 'var(--t-text-muted)', letterSpacing: '-0.1px' }}>{label}</div>
    </div>
  );
}

function StaticThreeDot() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        opacity: 0.45,
      }}
    >
      <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)', display: 'inline-block' }} />
      <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)', display: 'inline-block' }} />
      <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)', display: 'inline-block' }} />
    </span>
  );
}

function StaticSingleDot() {
  return (
    <span
      aria-hidden
      style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: 'var(--t-text-faint, #9ca3af)',
        opacity: 0.55,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

function StaticRing() {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        border: '1px solid var(--t-text-faint, #9ca3af)',
        background: 'transparent',
        opacity: 0.65,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

function StaticDash() {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 1.5,
        background: 'var(--t-text-faint, #9ca3af)',
        opacity: 0.55,
        flexShrink: 0,
        display: 'inline-block',
        borderRadius: 1,
      }}
    />
  );
}

function MockChatRowWorking() {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 260,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 12,
        paddingRight: 12,
        background: 'var(--t-panel, #ffffff)',
        borderRadius: 6,
      }}
    >
      <PulsingCircle />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          Ingest spec files to improve retrieval...
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            lineHeight: 1.25,
            color: 'var(--t-text-faint)',
          }}
        >
          main · running
        </span>
      </span>
    </div>
  );
}

function MockMissionCard() {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 260,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 9,
        paddingBottom: 9,
        paddingLeft: 12,
        paddingRight: 12,
        background: 'var(--t-panel, #ffffff)',
        border: '1px solid var(--t-divider, #e5e7eb)',
        borderRadius: 8,
        fontFamily: FONT,
      }}
    >
      <BinaryOrbit />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 12.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          Dispatching to Codex…
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-faint)',
          }}
        >
          issue/1130 · rebasing on main
        </span>
      </span>
    </div>
  );
}

function MockStatusBar() {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 280,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 12,
        paddingRight: 10,
        background: 'var(--t-panel, #ffffff)',
        border: '1px solid var(--t-divider, #e5e7eb)',
        borderRadius: 6,
        fontFamily: FONT,
      }}
    >
      <PulsingInfinityGlyph />
      <span
        style={{
          fontSize: 11,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          color: 'var(--t-text-muted)',
        }}
      >
        o8 v0.1.165
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
          color: 'var(--t-text-faint)',
        }}
      >
        14 chats · 8 agents
      </span>
    </div>
  );
}

// ── Pulse + ∞ variants ──────────────────────────────────────────────

function O8DualPulse() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      <motion.span
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)' }}
        animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }}
        transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
      />
      <motion.span
        style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)' }}
        animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1.05, 0.85] }}
        transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity, delay: 0.35 }}
      />
    </span>
  );
}

function InfinityDotTrace() {
  // SVG lemniscate as an offset-path for a single dot. The viewport is 26×14,
  // the path traces a horizontal infinity centered in it.
  const lemniscate = 'M 4 7 C 4 1, 12 1, 13 7 C 14 13, 22 13, 22 7 C 22 1, 14 1, 13 7 C 12 13, 4 13, 4 7 Z';
  return (
    <span style={{ position: 'relative', width: 26, height: 14, flexShrink: 0, display: 'inline-block' }}>
      <svg width={26} height={14} viewBox="0 0 26 14" style={{ position: 'absolute', inset: 0 }} aria-hidden>
        <path d={lemniscate} fill="none" stroke="var(--t-text-faint, #9ca3af)" strokeOpacity={0.18} strokeWidth={1} />
      </svg>
      <motion.span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 3.5,
          height: 3.5,
          borderRadius: '50%',
          background: 'var(--t-text-faint, #9ca3af)',
          offsetPath: `path('${lemniscate}')`,
          WebkitOffsetPath: `path('${lemniscate}')`,
        } as CSSProperties}
        animate={{ offsetDistance: ['0%', '100%'] }}
        transition={{ duration: 2.2, ease: 'linear', repeat: Infinity }}
      />
    </span>
  );
}

function InfinityStrokeDraw() {
  const lemniscate = 'M 4 7 C 4 1, 12 1, 13 7 C 14 13, 22 13, 22 7 C 22 1, 14 1, 13 7 C 12 13, 4 13, 4 7';
  // Approximate path length for the dashoffset animation
  const len = 56;
  return (
    <span style={{ width: 26, height: 14, flexShrink: 0, display: 'inline-block' }}>
      <svg width={26} height={14} viewBox="0 0 26 14" aria-hidden>
        <motion.path
          d={lemniscate}
          fill="none"
          stroke="var(--t-text-faint, #9ca3af)"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeDasharray={len}
          animate={{ strokeDashoffset: [len, 0, -len] }}
          transition={{ duration: 2.4, ease: 'easeInOut', repeat: Infinity }}
        />
      </svg>
    </span>
  );
}

function PulsingInfinityGlyph() {
  return (
    <motion.span
      style={{
        display: 'inline-block',
        fontSize: 16,
        lineHeight: 1,
        fontWeight: 300,
        letterSpacing: '-0.4px',
        color: 'var(--t-text-faint, #9ca3af)',
        flexShrink: 0,
      }}
      animate={{ opacity: [0.35, 1, 0.35] }}
      transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
    >
      ∞
    </motion.span>
  );
}

function BinaryOrbit() {
  return (
    <span style={{ position: 'relative', width: 16, height: 16, flexShrink: 0, display: 'inline-block' }}>
      <motion.span
        style={{ position: 'absolute', inset: 0 }}
        animate={{ rotate: 360 }}
        transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
      >
        <span style={{ position: 'absolute', top: 1, left: '50%', marginLeft: -1.5, width: 3, height: 3, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)' }} />
        <span style={{ position: 'absolute', bottom: 1, left: '50%', marginLeft: -1.5, width: 3, height: 3, borderRadius: '50%', background: 'var(--t-text-faint, #9ca3af)', opacity: 0.55 }} />
      </motion.span>
    </span>
  );
}

function RowExample({
  focused,
  workingShimmer,
  title,
  meta,
}: {
  focused: boolean;
  workingShimmer: boolean;
  title: string;
  meta: string;
}) {
  const shimmerStyle: CSSProperties = focused
    ? {
        backgroundImage: 'linear-gradient(110deg, var(--t-text) 0%, var(--t-text) 34%, var(--t-text-faint) 50%, var(--t-text) 66%, var(--t-text) 100%)',
        backgroundSize: '220% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        animation: 'o8-text-shimmer 2.35s linear infinite',
      }
    : {};

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 12,
        paddingRight: 12,
        background: focused ? 'var(--t-hover, #f4f4f5)' : 'transparent',
        borderRadius: 6,
        cursor: 'default',
      }}
    >
      {workingShimmer ? (
        <span className="o8-dot-shimmer">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className={focused ? 'o8-text-shimmer' : undefined}
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...shimmerStyle,
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: 9.5,
            lineHeight: 1.25,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-faint)',
          }}
        >
          {meta}
        </span>
      </span>
    </div>
  );
}
