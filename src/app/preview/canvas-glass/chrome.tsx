'use client';

/**
 * Canvas chrome — edge hover rails, dock glyph buttons, and the
 * browser-only diffusion backdrop (#1232).
 */

import { useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { FONT, glass } from './ui';

export function EdgeRail({
  side,
  open,
  onOpenChange,
  title,
  rows,
}: {
  side: 'left' | 'right';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  rows: Array<[string, string]>;
}) {
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  // Close only when the pointer truly leaves the zone+rail union — the rail
  // sits flush against the strip so travel between them never drops out.
  const closeUnlessWithin = (event: ReactMouseEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (zoneRef.current?.contains(next) || railRef.current?.contains(next))) return;
    onOpenChange(false);
  };
  return (
    <>
      {/* Hot zone — an 18px strip on the screen edge reveals the rail. */}
      <div
        ref={zoneRef}
        onMouseEnter={() => onOpenChange(true)}
        onMouseLeave={closeUnlessWithin}
        style={{
          position: 'absolute',
          top: 80,
          bottom: 96,
          width: 18,
          ...(side === 'left' ? { left: 0 } : { right: 0 }),
          zIndex: 41,
        }}
      />
      <motion.div
        ref={railRef}
        onMouseLeave={closeUnlessWithin}
        initial={false}
        animate={{
          x: open ? 0 : side === 'left' ? -252 : 252,
          opacity: open ? 1 : 0,
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        style={{
          position: 'absolute',
          top: 96,
          ...(side === 'left' ? { left: 18 } : { right: 18 }),
          width: 236,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          paddingTop: 12,
          paddingRight: 12,
          paddingBottom: 12,
          paddingLeft: 12,
          borderRadius: 14,
          zIndex: 42,
          pointerEvents: open ? 'auto' : 'none',
          ...glass(true),
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', marginBottom: 6, fontFamily: FONT }}>
          {title}
        </span>
        {rows.map(([primary, secondary]) => (
          <div key={primary} style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 5, paddingBottom: 5 }}>
            <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
              {primary}
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>{secondary}</span>
          </div>
        ))}
      </motion.div>
    </>
  );
}

export function DockGlyphButton({ label, path, extra, onClick, active }: { label: string; path: string; extra?: ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderWidth: 0,
        borderRadius: 13,
        background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        padding: 0,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={path} />
        {extra}
      </svg>
    </button>
  );
}

export function SpawnGlyphButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 34,
        height: 34,
        borderWidth: 0,
        borderRadius: 11,
        background: 'transparent',
        color: 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.color = 'var(--cnv-ink)';
        event.currentTarget.style.background = 'rgba(255,255,255,0.08)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = 'var(--cnv-ink-muted)';
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/** Slow drifting colour fields — the diffusion behind the glass. Browser-only
 *  stand-in for the real desktop that the app's native material shows. */
export function DiffusionBackdrop() {
  const blobs: Array<{ size: number; color: string; from: { x: string; y: string }; to: { x: string; y: string }; duration: number }> = [
    { size: 560, color: 'rgba(58, 96, 255, 0.32)', from: { x: '-6%', y: '8%' }, to: { x: '14%', y: '26%' }, duration: 46 },
    { size: 640, color: 'rgba(255, 122, 60, 0.20)', from: { x: '68%', y: '58%' }, to: { x: '52%', y: '40%' }, duration: 58 },
    { size: 480, color: 'rgba(160, 84, 255, 0.22)', from: { x: '38%', y: '-12%' }, to: { x: '54%', y: '4%' }, duration: 52 },
    { size: 520, color: 'rgba(34, 197, 94, 0.12)', from: { x: '10%', y: '70%' }, to: { x: '26%', y: '56%' }, duration: 64 },
  ];
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {blobs.map((blob, index) => (
        <motion.div
          key={index}
          animate={{ left: [blob.from.x, blob.to.x, blob.from.x], top: [blob.from.y, blob.to.y, blob.from.y] }}
          transition={{ duration: blob.duration, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            width: blob.size,
            height: blob.size,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${blob.color} 0%, transparent 70%)`,
            filter: 'blur(40px)',
          }}
        />
      ))}
    </div>
  );
}
