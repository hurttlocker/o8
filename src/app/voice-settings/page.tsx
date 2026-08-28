'use client';

/**
 * /voice-settings — the standalone Voice settings WINDOW, rebuilt as Symon's
 * borderless glass app: a 188px sidebar (in-app traffic lights + brand + tab nav)
 * beside a tabbed content area. Replaces the old single scrolling page. Opened by
 * double-tapping the dock — works even when the main o8 window is closed.
 *
 * The Tauri "voice-settings" window is transparent + decorations:false, so this
 * CSS glass card IS the window. Inline styles only, literal Symon dark-tone rgba
 * (no var(--t-*) — no ThemeProvider above this route), raw-SVG icons.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { isTauri, voicePrefsGet, voicePrefsSet } from '@/lib/tauri/bridge';
import {
  CONTENT_BG, GLASS_BORDER_SUBTLE, GRID_DOT, ICONS, NAV_ACTIVE, NAV_BORDER,
  NAV_HOVER, SF, SHELL_BORDER, SHELL_SHADOW, SIDEBAR_BG, TEXT_PRIMARY,
  TEXT_SECONDARY, TEXT_TERTIARY, TL_CLOSE, TL_CLOSE_HOVER, TL_MIN, TL_ZOOM, TRANS,
  VS_THEME_VARS, DEFAULT_GLASS, resolveGlass, scrimOpacity, type VsMode, type GlassControls, type VsText,
} from './tokens';
import { BrandGlyph, BrandWave, Icon } from './primitives';
import type { IconComp } from './icons';
import type { Prefs } from './helpers';
import SettingsTab from './tabs/SettingsTab';
import HistoryTab from './tabs/HistoryTab';
import StatsTab from './tabs/StatsTab';
import AccountTab from './tabs/AccountTab';
import ReportTab from './tabs/ReportTab';
import FounderTab from './tabs/FounderTab';
import AgentTab from './tabs/AgentTab';
import ThemeTab from './tabs/ThemeTab';
import { PolishTab } from './tabs/DataTabs';
import MemoryTab from './tabs/MemoryTab';

export const dynamic = 'force-dynamic';

type TabId = 'settings' | 'polish' | 'memory' | 'theme' | 'history' | 'stats' | 'account' | 'founder' | 'agent' | 'report';
const TABS: { id: TabId; label: string; icon: IconComp }[] = [
  { id: 'settings', label: 'Settings', icon: ICONS.gear },
  { id: 'polish', label: 'Polish', icon: ICONS.sparkle },
  { id: 'memory', label: 'Memory', icon: ICONS.bookOpen },
  { id: 'theme', label: 'Theme', icon: ICONS.droplet },
  { id: 'history', label: 'History', icon: ICONS.clock },
  { id: 'stats', label: 'Stats', icon: ICONS.chartBar },
  { id: 'account', label: 'Account', icon: ICONS.user },
  { id: 'founder', label: 'Voice', icon: ICONS.speakerHigh },
  { id: 'agent', label: 'Agent', icon: ICONS.robot },
  { id: 'report', label: 'Report Issue', icon: ICONS.warning },
];

const VS_GLASS_KEY = 'o8:vs-glass';

const PAGE_ROOT: CSSProperties = {
  width: '100vw', height: '100vh', margin: 0, padding: 0, background: 'transparent', overflow: 'hidden', fontFamily: SF,
};
const GLASS_SHELL_BASE: CSSProperties = {
  position: 'relative', isolation: 'isolate', display: 'flex', width: '100%', height: '100%',
  borderRadius: 22, overflow: 'hidden', border: `1px solid ${SHELL_BORDER}`,
  boxShadow: SHELL_SHADOW,
};

/** Build the live shell + scrim styles from resolved glass params. The scrim
 * (palette base color at clarity-derived opacity) provides the tint over the
 * vibrancy; backdrop blur + saturate are the frost; liquid adds a specular edge. */
function shellStyles(frost: number, saturate: number, clarity: number, brightness: number) {
  // blur = frost, saturate = color, brightness = material lift (all live knobs).
  const filter = `blur(${Math.round(frost)}px) saturate(${(saturate / 100).toFixed(2)}) brightness(${(brightness / 100).toFixed(2)})`;
  // Fixed baseline directional rim (top-left light source) — today's flat-glass
  // edge. Sheen + depth are added on top via a high-z finish overlay (below)
  // so they actually show over the content; an inset rim here would hide behind it.
  const rim = 'inset 0 1px 0 rgba(255,255,255,0.34), inset 1px 0 0 rgba(255,255,255,0.13)';
  const shell: CSSProperties = {
    ...GLASS_SHELL_BASE,
    background: 'radial-gradient(circle at top left, var(--vs-accent-radial), transparent 40%)',
    backdropFilter: filter, WebkitBackdropFilter: filter,
    boxShadow: `${SHELL_SHADOW}, ${rim}`,
  };
  const scrim: CSSProperties = {
    position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
    background: 'rgb(var(--vs-scrim-rgb))', opacity: scrimOpacity(clarity),
  };
  return { shell, scrim };
}

/** Lighting — the specular gloss + bright top/left edge, rendered ABOVE the
 * content (the shell fills the window, so an inset rim would hide behind the
 * cards). This is the dock pill's "lit edge" feel brought to the settings.
 * 0 → today's flat glass. */
function lightingFinish(lighting: number): CSSProperties | null {
  const l = Math.max(0, Math.min(100, lighting)) / 100;
  if (l === 0) return null;
  return {
    position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none', borderRadius: 22,
    backgroundImage: `linear-gradient(180deg, rgba(255,255,255,${(l * 0.26).toFixed(3)}) 0%, rgba(255,255,255,${(l * 0.05).toFixed(3)}) 9%, transparent 20%)`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,${(0.34 + l * 0.56).toFixed(2)}), inset 1px 0 0 rgba(255,255,255,${(0.13 + l * 0.3).toFixed(2)}), inset 0 0 ${Math.round(l * 60)}px rgba(255,255,255,${(l * 0.08).toFixed(2)})`,
  };
}

/** Diffusion — milky light-scattering (frosted softness). A uniform white veil
 * BEHIND the content (next to the scrim) so it softens the glass without washing
 * the text. 0 → clear. */
function diffusionVeil(diffusion: number): CSSProperties | null {
  const d = Math.max(0, Math.min(100, diffusion)) / 100;
  if (d === 0) return null;
  return {
    position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
    background: `rgba(255,255,255,${(d * 0.34).toFixed(3)})`,
  };
}

/** Above clarity 100, fade ONLY the in-between (the content area behind/around
 * the cards + its grid dots) toward transparent. The left sidebar and the
 * section cards keep their frosty backgrounds — so you get clear glass between
 * frosty surfaces, like the dock pill. Returns {} at/below 100 (normal look). */
function clarityOverrides(mode: VsMode, clarity: number, clearPanels: boolean): Record<string, string> {
  if (clarity <= 100) return {};
  const k = 1 - Math.min(1, (clarity - 100) / 100); // 1 → 0 as clarity 100 → 200
  const a = (base: number) => (base * k).toFixed(3);
  const light = mode === 'light';
  const out: Record<string, string> = light
    ? {
        '--vs-content-bg': `linear-gradient(180deg, rgba(255,255,255,${a(0.58)}), rgba(248,250,253,${a(0.42)}))`,
        '--vs-grid-dot': `rgba(15,23,42,${a(0.09)})`,
      }
    : {
        '--vs-content-bg': `linear-gradient(180deg, rgba(255,255,255,${a(0.05)}), rgba(255,255,255,${a(0.02)}))`,
        '--vs-grid-dot': `rgba(255,255,255,${a(0.08)})`,
      };
  // Opt-in: also dissolve the sidebar + the section cards for the full all-clear look.
  if (clearPanels) {
    if (light) {
      out['--vs-sidebar-bg'] = `linear-gradient(180deg, rgba(255,255,255,${a(0.82)}), rgba(244,247,251,${a(0.66)}))`;
      out['--vs-section-bg'] = `linear-gradient(180deg, rgba(255,255,255,${a(0.86)}), rgba(248,250,253,${a(0.70)}))`;
    } else {
      out['--vs-sidebar-bg'] = `linear-gradient(180deg, rgba(255,255,255,${a(0.09)}), rgba(255,255,255,${a(0.04)}))`;
      out['--vs-section-bg'] = `linear-gradient(180deg, rgba(255,255,255,${a(0.065)}), rgba(255,255,255,${a(0.025)}))`;
    }
  }
  return out;
}

/** Ink override — Light forces white text (reads when the glass is pushed fully
 * clear over a dark backdrop); Dark forces dark ink; Auto follows the palette. */
function textOverrides(text: VsText): Record<string, string> {
  if (text === 'light') {
    return {
      '--vs-text-primary': 'rgba(255,255,255,0.96)',
      '--vs-text-secondary': 'rgba(255,255,255,0.74)',
      '--vs-text-tertiary': 'rgba(255,255,255,0.52)',
    };
  }
  if (text === 'dark') {
    return {
      '--vs-text-primary': 'rgba(15,23,42,0.92)',
      '--vs-text-secondary': 'rgba(30,41,59,0.62)',
      '--vs-text-tertiary': 'rgba(51,65,85,0.50)',
    };
  }
  return {};
}

async function startDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().startDragging(); }
  catch { /* noop */ }
}

// Real window-drag UX: grab from any clear chrome area (around the title, the
// sidebar, gaps between cards) — but never from a control or inside a settings
// card (those carry data-drag-skip / are interactive), so clicks + text
// selection still work.
const DRAG_SKIP = 'button, input, select, textarea, a, [role="switch"], [data-drag-skip]';
function maybeStartDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  if (el && el.closest(DRAG_SKIP)) return;
  void startDrag(e);
}
async function closeWindow() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    // hide() preserves window state for a fast reopen, but needs the
    // allow-hide capability (shipping in the next native batch). Until then the
    // current binary only grants allow-close, so fall back to it.
    try { await w.hide(); } catch { await w.close(); }
  } catch { /* noop */ }
}

export default function VoiceSettingsWindow() {
  const tauri = isTauri();
  // Gate the tauri-only fallback on mount so SSR (no window → !tauri) and the
  // first client paint render the same tree — otherwise hydration mismatches and
  // Next surfaces a "1 Issue". After mount, a real browser still gets the notice.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [tab, setTab] = useState<TabId>('settings');
  const [prefs, setPrefs] = useState<Prefs>({});
  const [version, setVersion] = useState('');
  const [mode, setMode] = useState<VsMode>('dark');
  const [o8Transparent, setO8Transparent] = useState(true);
  const [glass, setGlass] = useState<GlassControls>(DEFAULT_GLASS);

  // Follow o8's palette + transparency. The main window persists both to
  // localStorage (`cortex-theme-palette`, `cortex-reduce-transparency`), which
  // this same-origin window shares; `storage` fires here when o8 flips them.
  useEffect(() => {
    const read = () => {
      try {
        const p = localStorage.getItem('cortex-theme-palette') || localStorage.getItem('cortex-theme') || '';
        setMode(p === 'light' ? 'light' : 'dark');
        // reduce-transparency 'on' = transparency OFF (solid surfaces).
        setO8Transparent(localStorage.getItem('cortex-reduce-transparency') !== 'on');
      } catch { /* noop */ }
    };
    read();
    window.addEventListener('storage', read);
    window.addEventListener('focus', read);
    return () => { window.removeEventListener('storage', read); window.removeEventListener('focus', read); };
  }, []);

  // Load the operator's glass fine-tune (Theme tab) from localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(VS_GLASS_KEY);
      if (raw) {
        const parsed = { ...DEFAULT_GLASS, ...JSON.parse(raw) };
        // The retired 'liquid' surface is now folded into 'glass' (same tune).
        if ((parsed.surface as string) === 'liquid') parsed.surface = 'glass';
        setGlass(parsed);
      }
    } catch { /* noop */ }
  }, []);
  // Live state updates instantly (smooth slider), but the localStorage write is
  // debounced — a synchronous write every drag tick fires the cross-window
  // `storage` event (re-rendering the dock too) and janks the frost glide.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateGlass = useCallback((next: GlassControls) => {
    setGlass(next);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try { localStorage.setItem(VS_GLASS_KEY, JSON.stringify(next)); } catch { /* noop */ }
    }, 150);
  }, []);

  const resolved = resolveGlass(glass, o8Transparent);
  const sx = shellStyles(resolved.frost, resolved.saturate, resolved.clarity, resolved.brightness);
  const lighting = lightingFinish(resolved.lighting);
  const diffusion = diffusionVeil(resolved.diffusion);
  const clearVars = clarityOverrides(mode, resolved.clarity, glass.clearPanels ?? false);
  const inkVars = textOverrides(glass.text ?? 'auto');
  // On-glass ink for modal-less sections: white when floating on the clear Glass
  // surface, the themed ink when on the opaque Solid surface.
  const onGlass = glass.surface === 'glass' || (glass.surface === 'auto' && o8Transparent);
  const onGlassInk: Record<string, string> = onGlass
    ? {
        '--vs-ink-onglass-1': 'rgba(255,255,255,0.96)',
        '--vs-ink-onglass-2': 'rgba(255,255,255,0.82)',
        '--vs-ink-onglass-3': 'rgba(255,255,255,0.70)',
      }
    : {
        '--vs-ink-onglass-1': 'var(--vs-text-primary)',
        '--vs-ink-onglass-2': 'var(--vs-text-secondary)',
        '--vs-ink-onglass-3': 'var(--vs-text-tertiary)',
      };

  const loadPrefs = useCallback(async () => {
    const p = await voicePrefsGet();
    if (p) setPrefs(p);
  }, []);
  useEffect(() => { if (tauri) void loadPrefs(); }, [tauri, loadPrefs]);

  // Optimistic local update + persist. Round-trips through voice_prefs_get.
  const setPref = useCallback((key: string, value: unknown) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    void voicePrefsSet(key, value);
  }, []);

  // The root layout paints body #1C1C1E — force it transparent here (like the
  // dock does) so the rounded glass card shows its corners against the desktop
  // instead of an opaque square behind it.
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prevH = html.style.background, prevB = body.style.background;
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => { html.style.background = prevH; body.style.background = prevB; };
  }, []);

  // App version for the brand block. Window size is set Rust-side (660×720).
  useEffect(() => {
    if (!tauri) return;
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => { /* noop */ });
  }, [tauri]);

  if (mounted && !tauri) {
    return (
      <div style={{ ...PAGE_ROOT, ...VS_THEME_VARS[mode], ...clearVars, ...inkVars, ...onGlassInk } as CSSProperties}><div style={sx.shell}>
        <div style={sx.scrim} aria-hidden />
        <p style={{ position: 'relative', zIndex: 1, margin: 'auto', fontSize: 13, color: TEXT_TERTIARY }}>
          Voice settings are only available in the desktop app.
        </p>
      </div></div>
    );
  }

  return (
    <div style={{ ...PAGE_ROOT, ...VS_THEME_VARS[mode], ...clearVars, ...inkVars, ...onGlassInk } as CSSProperties}>
      <div style={sx.shell} onMouseDown={maybeStartDrag}>
        <div style={sx.scrim} aria-hidden />
        {diffusion ? <div aria-hidden style={diffusion} /> : null}
        {lighting ? <div aria-hidden style={lighting} /> : null}

        {/* Sidebar */}
        <aside style={{
          position: 'relative', zIndex: 1, width: 188, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: SIDEBAR_BG, borderRight: `1px solid ${GLASS_BORDER_SUBTLE}`,
        }}>
          {/* Traffic lights — drag handled by the shell-level region */}
          <div style={{ display: 'flex', gap: 8, padding: '13px 14px 0' }}>
            <CloseDot />
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: TL_MIN }} />
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: TL_ZOOM }} />
          </div>
          {/* Brand — Symon, o8's voice agent (≠ orchestrator) */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            padding: '22px 18px 18px', borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}`,
          }}>
            <BrandGlyph size={36} />
            <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '0.24em', color: TEXT_PRIMARY, marginTop: 5, paddingLeft: '0.24em' }}>SYMON</span>
            <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.01em', color: TEXT_TERTIARY, marginTop: 1 }}>Your voice, working</span>
            <div style={{ marginTop: 6 }}><BrandWave /></div>
            {version ? <span style={{ fontSize: 9, color: TEXT_TERTIARY, opacity: 0.7, marginTop: 1 }}>o8 · v{version}</span> : null}
          </div>
          {/* Nav */}
          <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: 8 }}>
            {TABS.map((t) => <NavItem key={t.id} active={t.id === tab} icon={t.icon} label={t.label} onClick={() => setTab(t.id)} />)}
          </nav>
        </aside>

        {/* Content — single scroll container, 46px drag bar inside (Symon) */}
        <main style={{
          position: 'relative', zIndex: 1, flex: 1, minWidth: 0,
          overflowY: 'auto', overflowX: 'hidden', paddingLeft: 28, paddingRight: 28, paddingBottom: 28,
          background: `radial-gradient(circle at 1px 1px, ${GRID_DOT} 1px, transparent 0) 0 0 / 22px 22px, ${CONTENT_BG}`,
        }}>
          <div style={{ height: 46, cursor: 'grab' }} aria-hidden />
          {tab === 'settings' ? <SettingsTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'polish' ? <PolishTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'memory' ? <MemoryTab /> : null}
          {tab === 'theme' ? <ThemeTab controls={glass} onChange={updateGlass} /> : null}
          {tab === 'history' ? <HistoryTab /> : null}
          {tab === 'stats' ? <StatsTab /> : null}
          {tab === 'account' ? <AccountTab /> : null}
          {tab === 'founder' ? <FounderTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'agent' ? <AgentTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'report' ? <ReportTab /> : null}
        </main>
      </div>
    </div>
  );
}

function CloseDot() {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" aria-label="Close"
      onMouseDown={(e) => e.stopPropagation()} onClick={() => { void closeWindow(); }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: 12, height: 12, borderRadius: '50%', border: 'none', padding: 0, flexShrink: 0, cursor: 'pointer', background: hover ? TL_CLOSE_HOVER : TL_CLOSE }}
    />
  );
}

function NavItem({ active, icon, label, onClick }: { active: boolean; icon: IconComp; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const lit = active || hover;
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
        padding: '10px 12px', borderRadius: 12, cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: SF,
        color: lit ? TEXT_PRIMARY : TEXT_SECONDARY,
        background: active ? NAV_ACTIVE : hover ? NAV_HOVER : 'transparent',
        border: `1px solid ${active || hover ? NAV_BORDER : 'transparent'}`,
        boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.12)' : 'none',
        transition: `background ${TRANS}, color ${TRANS}, border-color ${TRANS}`,
      }}
    >
      <span style={{ display: 'flex', opacity: active ? 1 : 0.85 }}><Icon icon={icon} size={18} /></span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
