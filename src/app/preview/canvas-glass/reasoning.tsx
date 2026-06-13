'use client';

/**
 * ReasoningView — the model's thinking as a staged timeline (#1232,
 * operator reference 2026-06-12: "REASONING · 1:34 MIN" with per-stage
 * time chips, stage titles, dashed connectors).
 *
 * Stages are the stream's paragraph breaks; the times are REAL — the
 * entry pipeline stamps elapsed seconds as each paragraph closes. A
 * stage whose first line is short and unpunctuated reads as its title.
 * Live = expanded with a ticking header; settled = collapsed to the
 * header + first stage, click to toggle.
 */

import { useEffect, useState } from 'react';
import { FONT, TONE_DOT } from './ui';

/** Seconds while under a minute ("38s"), m:ss + " min" once it crosses one
 *  (Q: "reasoning should be in seconds not minutes only if it's at a minute"). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')} min`;
}

/** A short, unpunctuated first line reads as the stage's title. */
function splitStage(stage: string): { title: string | null; body: string } {
  const newline = stage.indexOf('\n');
  const first = (newline === -1 ? stage : stage.slice(0, newline)).trim();
  const rest = newline === -1 ? '' : stage.slice(newline + 1).trim();
  if (rest && first.length <= 64 && !/[.,;:!?]$/.test(first)) {
    return { title: first.replace(/^\*\*|\*\*$/g, ''), body: rest };
  }
  return { title: null, body: stage.trim() };
}

export function ReasoningView({
  text,
  live,
  startedAt,
  marks,
}: {
  text: string;
  live: boolean;
  startedAt?: number;
  marks?: number[];
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The header ticks while the model thinks.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const stages = text.split(/\n\s*\n/).map((stage) => stage.trim()).filter(Boolean);
  const lastMark = marks?.length ? marks[marks.length - 1] : 0;
  const totalSeconds = live && startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : Math.max(lastMark, 1);
  const expanded = live || open;
  const visible = expanded ? stages : stages.slice(0, 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <button
        type="button"
        onClick={() => { if (!live) setOpen((value) => !value); }}
        title={live ? 'Reasoning…' : open ? 'Collapse reasoning' : 'Expand reasoning'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          borderWidth: 0,
          background: 'transparent',
          padding: 0,
          cursor: live ? 'default' : 'pointer',
          fontFamily: FONT,
        }}
      >
        {live ? (
          <span aria-hidden className="o8-orbit" style={{ width: 9, height: 9, color: TONE_DOT.working, flexShrink: 0 }} />
        ) : null}
        <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}>
          {`Reasoning · ${formatElapsed(totalSeconds)}`}
        </span>
        {!live && stages.length > 1 ? (
          <span style={{ fontSize: 9, fontWeight: 260, color: 'var(--cnv-ink-muted)', opacity: 0.7 }}>
            {open ? 'collapse' : `${stages.length} stages`}
          </span>
        ) : null}
      </button>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {visible.map((stage, index) => {
          const { title, body } = splitStage(stage);
          const stageSeconds = marks && index < marks.length
            ? (index === 0 ? marks[0] : Math.max(0, marks[index] - marks[index - 1]))
            : null;
          const lastVisible = index === visible.length - 1;
          return (
            <div key={index} style={{ display: 'flex', gap: 11 }}>
              {/* Node dot + dashed connector down to the next stage. */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 6, flexShrink: 0, paddingTop: 5 }}>
                <span aria-hidden style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)', flexShrink: 0 }} />
                {!lastVisible ? (
                  <span aria-hidden style={{ flex: 1, width: 0, marginTop: 3, marginBottom: 1, borderLeft: '1px dashed var(--cnv-edge)' } as React.CSSProperties} />
                ) : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: lastVisible ? 0 : 16, minWidth: 0 }}>
                {stageSeconds !== null ? (
                  <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', opacity: 0.85, fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>
                    {formatElapsed(stageSeconds)}
                  </span>
                ) : null}
                {title ? (
                  <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '-0.15px', color: 'var(--cnv-ink)', fontFamily: FONT }}>
                    {title}
                  </span>
                ) : null}
                <span style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.55, color: 'var(--cnv-ink-muted)', whiteSpace: 'pre-wrap', fontFamily: FONT }}>
                  {body}
                </span>
              </div>
            </div>
          );
        })}
        {!expanded && stages.length > 1 ? (
          <span style={{ fontSize: 9, fontWeight: 260, color: 'var(--cnv-ink-muted)', opacity: 0.7, paddingLeft: 16, paddingTop: 2, fontFamily: FONT }}>
            {`+ ${stages.length - 1} more`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
