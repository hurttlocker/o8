'use client';

/**
 * Voice-settings shared primitives — the Symon "design system" ported to React
 * inline-style helpers, tuned to o8's hurttlocker spec: var(--font-sans-system),
 * weight 300 on chrome (never 600+), Iconoir icons. Every page stacks these.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  ACCENT, ACCENT_GLOW, ACCENT_LIGHT, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER,
  GLASS_BORDER_SUBTLE, OK_GREEN, SECTION_BG, SECTION_BORDER, SECTION_SHADOW, SF,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TRANS_FAST, WARN_AMBER, WAVE_STOPS,
  W_BODY, W_HEADING, W_STRONG,
} from './tokens';
import { Icon, type IconComp } from './icons';

export { Icon } from './icons';

// ── Brand glyph — CSS-rendered gradient orb (not SVG), verbatim from aqua ──
export function BrandGlyph({ size = 34 }: { size?: number }) {
  const warp = '44% 56% 52% 48% / 38% 41% 59% 62%';
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'grid', placeItems: 'center' }}>
      <div style={{
        position: 'absolute', inset: 2, borderRadius: warp, filter: 'blur(10px)', opacity: 0.92,
        background:
          'radial-gradient(circle at 24% 30%, rgba(136,209,241,0.36), transparent 36%),'
          + 'radial-gradient(circle at 72% 66%, rgba(177,180,229,0.34), transparent 32%),'
          + 'radial-gradient(circle at 60% 78%, rgba(245,184,196,0.30), transparent 34%)',
      }} />
      <div style={{
        position: 'absolute', inset: 6, borderRadius: warp, transform: 'rotate(-10deg)',
        background:
          'radial-gradient(circle at 66% 28%, rgba(255,255,255,0.88), transparent 26%),'
          + 'radial-gradient(circle at 36% 68%, rgba(136,209,241,0.92), transparent 48%),'
          + 'linear-gradient(135deg, #88d1f1, #b1b4e5 46%, #f5b8c4 78%, #f4c977)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.32), 0 10px 18px rgba(136,209,241,0.18)',
      }} />
      <div style={{
        position: 'absolute', width: 6, height: 6, right: 7, top: 7, borderRadius: 999,
        background: 'rgba(255,255,255,0.92)', boxShadow: '0 0 10px rgba(255,255,255,0.55)',
      }} />
    </div>
  );
}

// ── Brand wave — 96×16 box, gradient-stroked SVG (exact Symon path) ──
export function BrandWave() {
  return (
    <div style={{ width: 96, height: 16, opacity: 0.92 }}>
      <svg viewBox="0 0 120 18" fill="none" preserveAspectRatio="none" aria-hidden="true" style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <linearGradient id="vs-wave" x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor={WAVE_STOPS[0]} />
            <stop offset="34%" stopColor={WAVE_STOPS[1]} />
            <stop offset="72%" stopColor={WAVE_STOPS[2]} />
            <stop offset="100%" stopColor={WAVE_STOPS[3]} />
          </linearGradient>
        </defs>
        <path
          d="M4 9.5C13 8.1 17 5.5 24 5.5C31 5.5 36 12.5 44 12.5C51 12.5 55 6.5 63 6.5C71 6.5 74 13 82 13C91 13 95 5 104 5C110 5 114 7.5 116 8.5"
          stroke="url(#vs-wave)" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

// ── Toggle (iOS switch) ──
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [focus, setFocus] = useState(false);
  return (
    <button
      type="button" role="switch" aria-checked={checked}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onClick={() => onChange(!checked)}
      style={{
        position: 'relative', width: 44, height: 24, borderRadius: 12, padding: 0, marginTop: 1,
        background: checked ? ACCENT : GLASS_BORDER, cursor: 'pointer', flexShrink: 0,
        border: 'none', outline: 'none', transition: 'background 200ms ease',
        boxShadow: focus ? `0 0 0 2px ${ACCENT_GLOW}` : 'none',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: 2, width: 20, height: 20, borderRadius: '50%',
        background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        transition: 'transform 200ms ease', transform: checked ? 'translateX(20px)' : 'translateX(0)',
      }} />
    </button>
  );
}

// ── Buttons ──
export function GhostButton({ label, onClick, tone }: { label: string; onClick: () => void; tone?: 'ok' | 'danger' }) {
  const [hover, setHover] = useState(false);
  const base = tone === 'ok' ? OK_GREEN : tone === 'danger' ? WARN_AMBER : TEXT_SECONDARY;
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 8,
        border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: hover ? GLASS_BG_HOVER : 'transparent',
        color: hover ? TEXT_PRIMARY : base, fontSize: 11, fontWeight: W_BODY, fontFamily: SF,
        cursor: 'pointer', transition: `background ${TRANS_FAST}, color ${TRANS_FAST}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {label}
    </button>
  );
}

export function AccentButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        height: 30, paddingLeft: 14, paddingRight: 14, borderRadius: 9,
        border: '1px solid rgba(90,132,255,0.30)', background: hover ? 'rgba(90,132,255,0.26)' : 'rgba(90,132,255,0.18)',
        color: ACCENT_LIGHT, fontSize: 12, fontWeight: W_HEADING, fontFamily: SF, cursor: 'pointer',
        transition: `background ${TRANS_FAST}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
      }}
    >
      {label}
    </button>
  );
}

// ── Section card + title ──
export function SectionCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      padding: '16px 18px', borderRadius: 18, border: `1px solid ${SECTION_BORDER}`,
      background: SECTION_BG, boxShadow: SECTION_SHADOW,
      backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      ...style,
    }}>
      {children}
    </div>
  );
}

export function SectionTitle({ icon, children, status, right }: {
  icon: IconComp; children: ReactNode; status?: string; right?: ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12,
      fontSize: 10, fontWeight: W_BODY, color: TEXT_SECONDARY, textTransform: 'uppercase', letterSpacing: '0.12em',
    }}>
      <span style={{ color: ACCENT, display: 'flex', opacity: 0.95 }}><Icon icon={icon} size={14} /></span>
      <span style={{ marginRight: 'auto' }}>{children}</span>
      {status ? (
        <span style={{
          padding: '2px 8px', borderRadius: 999, fontSize: 9, fontWeight: W_STRONG, letterSpacing: '0.1em',
          color: OK_GREEN, background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.34)',
        }}>{status}</span>
      ) : null}
      {right}
    </div>
  );
}

export function SectionHint({ children }: { children: ReactNode }) {
  return (
    <p style={{ fontSize: 12, color: TEXT_TERTIARY, lineHeight: 1.5, marginTop: -2, marginBottom: 12, maxWidth: 460 }}>
      {children}
    </p>
  );
}

// ── Rows ──
export function ToggleRow({ label, detail, checked, onChange, pro }: {
  label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void; pro?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 11, paddingBottom: 11, borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: W_BODY, color: TEXT_PRIMARY }}>
          {label}{pro ? <ProPill /> : null}
        </div>
        {detail ? <div style={{ fontSize: 12, color: TEXT_TERTIARY, lineHeight: 1.45, marginTop: 4, maxWidth: 360 }}>{detail}</div> : null}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

export function ControlRow({ label, detail, children, stacked }: {
  label: ReactNode; detail?: string; children: ReactNode; stacked?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: stacked ? 'column' : 'row',
      alignItems: stacked ? 'stretch' : 'center', justifyContent: 'space-between',
      gap: stacked ? 10 : 16, paddingTop: 11, paddingBottom: 11, borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}`,
    }}>
      <div style={{ flex: stacked ? undefined : 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: W_BODY, color: TEXT_PRIMARY }}>{label}</div>
        {detail ? <div style={{ fontSize: 12, color: TEXT_TERTIARY, lineHeight: 1.45, marginTop: 4, maxWidth: 360 }}>{detail}</div> : null}
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>
    </div>
  );
}

export function ProPill() {
  return (
    <span style={{
      display: 'inline-block', marginLeft: 7, padding: '1px 7px', borderRadius: 999,
      border: '1px solid rgba(125,211,252,0.45)', background: 'rgba(125,211,252,0.14)',
      color: '#7dd3fc', fontSize: 9, fontWeight: W_STRONG, letterSpacing: '0.08em', textTransform: 'uppercase', verticalAlign: 'middle',
    }}>Pro</span>
  );
}

// ── Select ──
export function Select({ value, onChange, options, width = 220 }: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; width?: number;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      style={{
        minWidth: width, height: 32, paddingLeft: 10, paddingRight: 26, borderRadius: 8,
        border: `1px solid ${focus ? ACCENT : GLASS_BORDER_SUBTLE}`, background: GLASS_BG,
        color: TEXT_PRIMARY, fontSize: 12, fontFamily: SF, outline: 'none', cursor: 'pointer',
        boxShadow: focus ? `0 0 0 2px ${ACCENT_GLOW}` : 'none',
        WebkitAppearance: 'none', appearance: 'none',
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
      } as CSSProperties}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} style={{ background: '#0e1622', color: TEXT_PRIMARY }}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Segmented control ──
export function Segmented({ value, onChange, options, full }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; full?: boolean;
}) {
  return (
    <div style={{
      display: full ? 'grid' : 'inline-grid', gridAutoFlow: 'column',
      gridAutoColumns: full ? '1fr' : undefined, gap: 2, minHeight: 32, padding: 3,
      width: full ? '100%' : undefined, borderRadius: 8,
      border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: GLASS_BG,
    }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <SegButton key={o.value} active={active} onClick={() => onChange(o.value)}>{o.label}</SegButton>
        );
      })}
    </div>
  );
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        minWidth: 54, height: 24, paddingLeft: 9, paddingRight: 9, border: 'none', borderRadius: 6,
        fontSize: 11, fontWeight: W_BODY, fontFamily: SF, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: active ? TEXT_PRIMARY : hover ? TEXT_PRIMARY : TEXT_TERTIARY,
        background: active ? 'rgba(64,88,255,0.18)' : hover ? GLASS_BG_HOVER : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px rgba(64,88,255,0.34)' : 'none',
        transition: `background 160ms ease, color 160ms ease`,
      }}
    >
      {children}
    </button>
  );
}

// ── Slider ──
export function Slider({ value, min, max, step, onChange, suffix }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          WebkitAppearance: 'none', appearance: 'none', width: 130, height: 4, borderRadius: 2,
          background: `linear-gradient(90deg, ${ACCENT} ${((value - min) / (max - min)) * 100}%, ${GLASS_BORDER} ${((value - min) / (max - min)) * 100}%)`,
          outline: 'none', cursor: 'pointer', border: 'none',
        } as CSSProperties}
      />
      <span style={{ fontSize: 12, color: TEXT_SECONDARY, minWidth: 38, fontVariantNumeric: 'tabular-nums' }}>
        {value.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}{suffix ?? ''}
      </span>
    </div>
  );
}

// ── Status badge ──
export function StatusBadge({ ok, okLabel = 'Granted', warnLabel = 'Needs grant' }: {
  ok: boolean; okLabel?: string; warnLabel?: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: ok ? OK_GREEN : WARN_AMBER }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? OK_GREEN : WARN_AMBER, boxShadow: ok ? '0 0 5px rgba(52,211,153,0.5)' : 'none' }} />
      {ok ? okLabel : warnLabel}
    </span>
  );
}

export const PAGE_TITLE_STYLE: CSSProperties = {
  fontSize: 19, fontWeight: W_HEADING, letterSpacing: '-0.02em', color: TEXT_PRIMARY, margin: 0,
};
