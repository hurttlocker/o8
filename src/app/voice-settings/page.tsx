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
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { isTauri, voicePrefsGet, voicePrefsSet } from '@/lib/tauri/bridge';
import {
  CONTENT_BG, GLASS_BORDER_SUBTLE, GRID_DOT, ICONS, NAV_ACTIVE, NAV_BORDER,
  NAV_HOVER, SF, SHELL_BORDER, SHELL_SHADOW, SIDEBAR_BG, TEXT_PRIMARY,
  TEXT_SECONDARY, TEXT_TERTIARY, TL_CLOSE, TL_CLOSE_HOVER, TL_MIN, TL_ZOOM, TRANS,
  VS_THEME_VARS, DEFAULT_GLASS, resolveGlass, scrimOpacity, type VsMode, type GlassControls,
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

export const dynamic = 'force-dynamic';

type TabId = 'settings' | 'polish' | 'theme' | 'history' | 'stats' | 'account' | 'founder' | 'agent' | 'report';
const TABS: { id: TabId; label: string; icon: IconComp }[] = [
  { id: 'settings', label: 'Settings', icon: ICONS.gear },
  { id: 'polish', label: 'Polish', icon: ICONS.sparkle },
  { id: 'theme', label: 'Theme', icon: ICONS.droplet },
  { id: 'history', label: 'History', icon: ICONS.clock },
  { id: 'stats', label: 'Stats', icon: ICONS.chartBar },
  { id: 'account', label: 'Account', icon: ICONS.user },
  { id: 'founder', label: 'Founder', icon: ICONS.crown },
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
function shellStyles(frost: number, saturate: number, clarity: number, liquid: boolean) {
  // saturate + a hair of brightness lift the material; blur is the frost knob.
  const filter = `blur(${Math.round(frost)}px) saturate(${(saturate / 100).toFixed(2)}) brightness(1.04)`;
  // Directional rim (top-left light source) — the specular "tell" that makes the
  // pane read as glass even at frost 0 / clarity 100 (Gemini's #1 note from the
  // Liquid Glass breakdown). Stronger when liquid.
  const rim = liquid
    ? 'inset 0 1.5px 0 rgba(255,255,255,0.6), inset 1.5px 0 0 rgba(255,255,255,0.26), inset 0 0 46px rgba(255,255,255,0.06)'
    : 'inset 0 1px 0 rgba(255,255,255,0.34), inset 1px 0 0 rgba(255,255,255,0.13)';
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
  return { shell, scrim, liquid };
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
      if (raw) setGlass({ ...DEFAULT_GLASS, ...JSON.parse(raw) });
    } catch { /* noop */ }
  }, []);
  const updateGlass = useCallback((next: GlassControls) => {
    setGlass(next);
    try { localStorage.setItem(VS_GLASS_KEY, JSON.stringify(next)); } catch { /* noop */ }
  }, []);

  const resolved = resolveGlass(glass, o8Transparent);
  const liquid = resolved.saturate >= 150;
  const sx = shellStyles(resolved.frost, resolved.saturate, resolved.clarity, liquid);

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
      <div style={{ ...PAGE_ROOT, ...VS_THEME_VARS[mode] } as CSSProperties}><div style={sx.shell}>
        <div style={sx.scrim} aria-hidden />
        <p style={{ position: 'relative', zIndex: 1, margin: 'auto', fontSize: 13, color: TEXT_TERTIARY }}>
          Voice settings are only available in the desktop app.
        </p>
      </div></div>
    );
  }

  return (
    <div style={{ ...PAGE_ROOT, ...VS_THEME_VARS[mode] } as CSSProperties}>
      <div style={sx.shell} onMouseDown={maybeStartDrag}>
        <div style={sx.scrim} aria-hidden />
        {sx.liquid ? (
          <div aria-hidden style={{
            position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.16), transparent 38%)',
          }} />
        ) : null}

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
        transform: hover && !active ? 'translateY(-1px)' : 'none',
        transition: `background ${TRANS}, color ${TRANS}, border-color ${TRANS}, transform ${TRANS}`,
      }}
    >
      <span style={{ display: 'flex', opacity: active ? 1 : 0.85 }}><Icon icon={icon} size={18} /></span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
