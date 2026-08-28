'use client';

import type { ReactNode } from 'react';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import { FONT } from './ui';

type CanvasMode = OrchestratorExecutionMode;

/** Section label inside the composer drawer (uppercase, muted). */
export function DrawerLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 5 }}>
      {children}
    </span>
  );
}

export function PickerRow({ name, path, active, onClick }: { name: string; path?: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderWidth: 0,
        background: 'transparent',
        borderRadius: 9,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: FONT,
        width: '100%',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: active ? 500 : 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink)' }}>{name}</span>
        {path ? (
          <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{path}</span>
        ) : null}
      </span>
      {active ? (
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  );
}

/** Small pill control in the composer — repo scope + model (with a muted
 *  thinking-effort suffix via `sub`). */
export function ChipButton({ label, sub, active, onClick }: { label: string; sub?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 24,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--cnv-edge)',
        background: active ? 'var(--cnv-tint)' : 'transparent',
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        fontSize: 9.5,
        fontWeight: 400,
        letterSpacing: '0.02em',
        cursor: 'pointer',
        fontFamily: FONT,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      {label}
      {sub ? <span style={{ marginLeft: 5, fontWeight: 300, opacity: 0.55 }}>{sub}</span> : null}
    </button>
  );
}

/** Glyph for an orchestration mode — fleet fan-out, single node, fusion
 *  sparkle. Shared by the composer's mode trigger and the MODE popover rows so
 *  the chip always shows the live mode's mark. */
export function ModeGlyph({ mode, size = 13 }: { mode: CanvasMode; size?: number }) {
  if (mode === 'single') {
    // One node inside a ring — the visual opposite of fleet's three-node fan-out.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
        <circle cx="12" cy="12" r="3" />
        <circle cx="12" cy="12" r="8" />
      </svg>
    );
  }
  if (mode === 'fusion') {
    // Sparkle — reads as the "deeper / more" pass beside the fleet fan-out.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
      </svg>
    );
  }
  // fleet — three nodes fanning out (matches the default composer's FleetGlyph).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

/** One row in the composer's MODE popover — glyph + title + detail, orange
 *  check on the live mode. Canvas-token twin of the default composer's
 *  PopoverRow (richer than PickerRow, which is title-only). */
export function ModeRow({ mode, title, detail, active, onClick }: { mode: CanvasMode; title: string; detail: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      style={{
        display: 'grid',
        gridTemplateColumns: '18px minmax(0, 1fr) 14px',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        borderWidth: 0,
        background: active ? 'var(--cnv-tint)' : 'transparent',
        borderRadius: 9,
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 8,
        paddingRight: 8,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: FONT,
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--cnv-tint)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
    >
      <span aria-hidden style={{ display: 'inline-flex', color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--cnv-ink-muted)' }}>
        <ModeGlyph mode={mode} size={13} />
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', lineHeight: 1.25 }}>{title}</span>
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', letterSpacing: '-0.05px', lineHeight: 1.3 }}>{detail}</span>
      </span>
      <span aria-hidden style={{ display: 'inline-flex', opacity: active ? 1 : 0, color: 'var(--t-brand-orange, #FF5A1F)' }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </span>
    </button>
  );
}
