'use client';

/**
 * ThemeLab — DEV-ONLY live theme tweaker (operator request 2026-07-14).
 *
 * ⌘⌃G toggles a floating panel that live-edits the solid center-surface
 * tokens (the "middle of glass mode") via inline root CSS-var overrides, so
 * the operator can dial hue/tone by eye in dev-bridge and hand the winning
 * value back to be baked into src/lib/theme/registry.ts.
 *
 * Renders NOTHING outside `next dev` (NODE_ENV gate) — this never ships
 * active in a packaged build. Overrides are session-local: a palette/surface
 * toggle re-applies registry values over them (by design; this is a probe,
 * not a persistence layer).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, Menlo, monospace';

const TOKENS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '--t-chat-surface-bg', label: 'Center · chat paper' },
  { id: '--t-canvas-bg', label: 'Canvas surface' },
  { id: '--t-terminal-bg', label: 'Terminal surface' },
  { id: '--t-panel-solid', label: 'Opaque panels / menus' },
  { id: '--t-bg', label: 'Base background' },
];

const PRESETS: ReadonlyArray<{ label: string; hex: string }> = [
  { label: 'Cursor', hex: '#1e1e1e' },
  { label: 'Neutral', hex: '#232323' },
  { label: 'Graphite', hex: '#26262a' },
  { label: 'Warm', hex: '#211f1d' },
];

// All-glass mode (Q 2026-07-17 v2: "we don't need tint — darkness and blur,
// vibrancy"): glass is a MATERIAL, not a color. The real controls are the
// macOS NSVisualEffectMaterial (each is a fixed blur/frost recipe — material
// choice IS the blur dial; CSS backdrop-filter is dead in Tauri) and a
// near-black darkness veil per surface group. Bake winners into
// WORKSPACE_GLASS_OVERRIDES (theme/context.tsx) + the boot material.
const GLASS_DARKNESS_GROUPS: ReadonlyArray<{ label: string; ids: string[] }> = [
  { label: 'Workspace darkness (chat · canvas · terminal)', ids: ['--t-chat-surface-bg', '--t-canvas-bg', '--t-terminal-bg'] },
  { label: 'Panel darkness', ids: ['--t-panel'] },
];
// The veil is always this near-black; only its alpha moves.
const GLASS_VEIL_RGB = '13, 15, 19';
// Mirrors set_canvas_material's accepted ids (src-tauri/lib.rs).
const GLASS_MATERIALS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'default', label: 'Chrome' },
  { id: 'hud', label: 'HUD' },
  { id: 'under-window', label: 'Under' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'popover', label: 'Popover' },
  { id: 'menu', label: 'Menu' },
  { id: 'sheet', label: 'Sheet' },
  { id: 'window', label: 'Window' },
  { id: 'fullscreen', label: 'Full' },
  { id: 'none', label: 'Clear' },
];

function readVeilAlpha(token: string): number {
  if (typeof document === 'undefined') return 35;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const m = raw.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)$/);
  return m ? Math.round(Number(m[1]) * 100) : raw && raw !== 'transparent' ? 100 : 0;
}

type Hsl = { h: number; s: number; l: number };

function hexToHsl(raw: string): Hsl | null {
  const m = raw.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex({ h, s, l }: Hsl): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`;
}

function readTokenHsl(token: string): Hsl {
  if (typeof document === 'undefined') return { h: 0, s: 0, l: 12 };
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return hexToHsl(raw) ?? { h: 216, s: 16, l: 12 };
}


export function ThemeLab() {
  const isDev = process.env.NODE_ENV === 'development';
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'solid' | 'glass'>('solid');
  const [tokenId, setTokenId] = useState(TOKENS[0].id);
  const [hsl, setHsl] = useState<Hsl>({ h: 216, s: 16, l: 12 });
  const [darkness, setDarkness] = useState<number[]>(() => GLASS_DARKNESS_GROUPS.map(() => 35));
  const [material, setMaterial] = useState('default');
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isDev) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.ctrlKey && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDev]);

  useEffect(() => {
    if (!open) return;
    // rAF defer — reading computed style + setState synchronously inside the
    // effect trips the cascading-render lint; one frame later is identical
    // for a dev probe.
    const raf = requestAnimationFrame(() => {
      if (mode === 'glass') setDarkness(GLASS_DARKNESS_GROUPS.map((group) => readVeilAlpha(group.ids[0])));
      else setHsl(readTokenHsl(tokenId));
    });
    return () => cancelAnimationFrame(raf);
  }, [open, tokenId, mode]);

  const hex = useMemo(() => hslToHex(hsl), [hsl]);

  const apply = useCallback((next: Hsl) => {
    setHsl(next);
    document.documentElement.style.setProperty(tokenId, hslToHex(next));
    setTouched((prev) => new Set(prev).add(tokenId));
    setCopied(false);
  }, [tokenId]);

  const applyDarkness = useCallback((groupIdx: number, alpha: number) => {
    setDarkness((prev) => prev.map((v, i) => (i === groupIdx ? alpha : v)));
    const value = `rgba(${GLASS_VEIL_RGB}, ${(alpha / 100).toFixed(2)})`;
    setTouched((prev) => {
      const set = new Set(prev);
      for (const id of GLASS_DARKNESS_GROUPS[groupIdx].ids) {
        document.documentElement.style.setProperty(id, value);
        set.add(id);
      }
      return set;
    });
    setCopied(false);
  }, []);

  const applyMaterial = useCallback((id: string) => {
    setMaterial(id);
    setCopied(false);
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_canvas_material', { material: id });
      } catch (err) {
        console.warn('[theme-lab] material swap failed:', err);
      }
    })();
  }, []);

  const applyPreset = useCallback((presetHex: string) => {
    const parsed = hexToHsl(presetHex);
    if (parsed) apply(parsed);
  }, [apply]);

  const resetAll = useCallback(() => {
    for (const id of touched) document.documentElement.style.removeProperty(id);
    setTouched(new Set());
    if (mode === 'glass') {
      setDarkness(GLASS_DARKNESS_GROUPS.map((group) => readVeilAlpha(group.ids[0])));
      if (material !== 'default') applyMaterial('default');
    } else {
      setHsl(readTokenHsl(tokenId));
    }
    setCopied(false);
  }, [tokenId, touched, mode, material, applyMaterial]);

  const copyValue = useCallback(() => {
    const payload = mode === 'glass'
      ? [
          `// material: ${material}`,
          ...GLASS_DARKNESS_GROUPS.flatMap((group, i) =>
            group.ids.map((id) => `'${id}': 'rgba(${GLASS_VEIL_RGB}, ${(darkness[i] / 100).toFixed(2)})',`)),
        ].join('\n')
      : `'${tokenId}': '${hex}',`;
    void navigator.clipboard.writeText(payload).then(() => setCopied(true));
  }, [hex, tokenId, mode, material, darkness]);

  if (!isDev || !open || typeof document === 'undefined') return null;

  const slider = (label: string, value: number, max: number, onChange: (v: number) => void) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT }}>
      <span style={{ width: 12, flexShrink: 0 }}>{label}</span>
      <input
        type="range"
        min={0}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ width: 30, textAlign: 'right', fontFamily: MONO, fontSize: 10, color: 'var(--t-text)' }}>{value}</span>
    </label>
  );

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 52,
        right: 16,
        zIndex: 320,
        width: 268,
        borderRadius: 13,
        border: '1px solid var(--t-divider-strong)',
        background: 'var(--t-panel-solid)',
        boxShadow: '0 22px 56px rgba(0, 0, 0, 0.32)',
        padding: 12,
        color: 'var(--t-text)',
        fontFamily: FONT,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 620, letterSpacing: '0.02em' }}>THEME LAB</span>
        <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', fontFamily: MONO }}>dev · ⌘⌃G</span>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['solid', 'glass'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setCopied(false); }}
            style={{
              flex: 1,
              minHeight: 24,
              borderRadius: 8,
              border: '1px solid var(--t-divider-subtle)',
              background: mode === m ? 'var(--t-hover)' : 'transparent',
              color: mode === m ? 'var(--t-text)' : 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: 10,
            }}
          >
            {m === 'solid' ? 'Solid tokens' : 'All-glass (rgba)'}
          </button>
        ))}
      </div>

      {mode === 'glass' ? (
        <>
          <div style={{ fontSize: 9.5, letterSpacing: '0.05em', color: 'var(--t-text-faint)', marginBottom: 5, fontFamily: FONT }}>
            BLUR · vibrancy material (fixed macOS recipes)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4, marginBottom: 10 }}>
            {GLASS_MATERIALS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => applyMaterial(m.id)}
                style={{
                  minHeight: 24,
                  borderRadius: 7,
                  border: '1px solid var(--t-divider-subtle)',
                  background: material === m.id ? 'var(--t-hover)' : 'transparent',
                  color: material === m.id ? 'var(--t-text)' : 'var(--t-text-muted)',
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 9,
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 9.5, letterSpacing: '0.05em', color: 'var(--t-text-faint)', marginBottom: 5, fontFamily: FONT }}>
            DARKNESS · near-black veil alpha
          </div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
            {GLASS_DARKNESS_GROUPS.map((group, idx) => (
              <div key={group.label} style={{ display: 'grid', gap: 3 }}>
                <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: FONT }}>{group.label}</span>
                {slider('D', darkness[idx] ?? 0, 100, (a) => applyDarkness(idx, a))}
              </div>
            ))}
          </div>
        </>
      ) : (
      <>
      <div style={{ display: 'grid', gap: 2, marginBottom: 10 }}>
        {TOKENS.map((token) => {
          const active = token.id === tokenId;
          return (
            <button
              key={token.id}
              type="button"
              onClick={() => setTokenId(token.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                minHeight: 26,
                borderRadius: 8,
                border: 0,
                background: active ? 'var(--t-hover)' : 'transparent',
                color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
                cursor: 'pointer',
                textAlign: 'left',
                paddingLeft: 7,
                paddingRight: 7,
                fontFamily: FONT,
                fontSize: 10.5,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 4,
                  flexShrink: 0,
                  background: `var(${token.id})`,
                  border: '1px solid var(--t-divider-strong)',
                }}
              />
              <span style={{ flex: 1 }}>{token.label}</span>
              {touched.has(token.id) ? <span style={{ fontSize: 8.5, color: 'var(--t-text-faint)' }}>edited</span> : null}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
        {slider('H', hsl.h, 360, (h) => apply({ ...hsl, h }))}
        {slider('S', hsl.s, 100, (s) => apply({ ...hsl, s }))}
        {slider('L', hsl.l, 100, (l) => apply({ ...hsl, l }))}
      </div>
      </>
      )}

      {mode === 'solid' ? (
      <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => applyPreset(preset.hex)}
            style={{
              flex: 1,
              display: 'grid',
              justifyItems: 'center',
              gap: 3,
              border: '1px solid var(--t-divider-subtle)',
              borderRadius: 8,
              background: 'transparent',
              cursor: 'pointer',
              paddingTop: 5,
              paddingBottom: 5,
              color: 'var(--t-text-muted)',
              fontFamily: FONT,
              fontSize: 9,
            }}
          >
            <span aria-hidden style={{ width: 18, height: 18, borderRadius: 6, background: preset.hex, border: '1px solid var(--t-divider-strong)' }} />
            {preset.label}
          </button>
        ))}
      </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <code style={{ flex: 1, fontFamily: MONO, fontSize: 10.5, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mode === 'glass' ? `${material} · ${darkness.map((d) => `${d}%`).join(' / ')}` : hex}</code>
        <button
          type="button"
          onClick={copyValue}
          style={{
            border: '1px solid var(--t-btn-secondary-border)',
            borderRadius: 7,
            background: 'var(--t-btn-secondary-bg)',
            color: 'var(--t-text)',
            cursor: 'pointer',
            fontFamily: FONT,
            fontSize: 10,
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 8,
            paddingRight: 8,
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={resetAll}
          style={{
            border: 0,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            cursor: 'pointer',
            fontFamily: FONT,
            fontSize: 10,
          }}
        >
          Reset
        </button>
      </div>

      <div style={{ marginTop: 8, fontSize: 9, lineHeight: '12px', color: 'var(--t-text-faint)', fontFamily: FONT }}>
        Session-local probe — palette/surface toggles reset it. Copy the value and hand it to Claude to bake into the registry.
      </div>
    </div>,
    document.body,
  );
}
