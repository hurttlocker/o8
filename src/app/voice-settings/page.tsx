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
  CONTENT_BG, FROST_BASE, GLASS_BORDER_SUBTLE, GRID_DOT, ICONS, NAV_ACTIVE, NAV_BORDER,
  NAV_HOVER, SF, SHELL_BG, SHELL_BORDER, SHELL_SHADOW, SIDEBAR_BG, TEXT_PRIMARY,
  TEXT_SECONDARY, TEXT_TERTIARY, TL_CLOSE, TL_CLOSE_HOVER, TL_MIN, TL_ZOOM, TRANS,
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
import { DictionaryTab, SnippetsTab, InstructionsTab } from './tabs/DataTabs';

export const dynamic = 'force-dynamic';

type TabId = 'settings' | 'dictionary' | 'snippets' | 'instructions' | 'history' | 'stats' | 'account' | 'founder' | 'agent' | 'report';
const TABS: { id: TabId; label: string; icon: IconComp }[] = [
  { id: 'settings', label: 'Settings', icon: ICONS.gear },
  { id: 'dictionary', label: 'Dictionary', icon: ICONS.bookOpen },
  { id: 'snippets', label: 'Snippets', icon: ICONS.arrowsLeftRight },
  { id: 'instructions', label: 'Instructions', icon: ICONS.notePencil },
  { id: 'history', label: 'History', icon: ICONS.clock },
  { id: 'stats', label: 'Stats', icon: ICONS.chartBar },
  { id: 'account', label: 'Account', icon: ICONS.user },
  { id: 'founder', label: 'Founder', icon: ICONS.crown },
  { id: 'agent', label: 'Agent', icon: ICONS.robot },
  { id: 'report', label: 'Report Issue', icon: ICONS.warning },
];

const PAGE_ROOT: CSSProperties = {
  width: '100vw', height: '100vh', margin: 0, padding: 0, background: 'transparent', overflow: 'hidden', fontFamily: SF,
};
const GLASS_SHELL: CSSProperties = {
  position: 'relative', isolation: 'isolate', display: 'flex', width: '100%', height: '100%',
  borderRadius: 22, overflow: 'hidden', border: `1px solid ${SHELL_BORDER}`,
  background: `radial-gradient(circle at top left, rgba(64,88,255,0.20), transparent 38%), ${SHELL_BG}`,
  backdropFilter: 'blur(28px) saturate(1.08)', WebkitBackdropFilter: 'blur(28px) saturate(1.08)',
  boxShadow: SHELL_SHADOW,
};
const FROST_LAYER: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
  background: FROST_BASE, backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)',
};

async function startDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().startDragging(); }
  catch { /* noop */ }
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
  const [tab, setTab] = useState<TabId>('settings');
  const [prefs, setPrefs] = useState<Prefs>({});
  const [version, setVersion] = useState('');

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

  if (!tauri) {
    return (
      <div style={PAGE_ROOT}><div style={GLASS_SHELL}>
        <div style={{ ...FROST_LAYER }} />
        <p style={{ position: 'relative', zIndex: 1, margin: 'auto', fontSize: 13, color: TEXT_TERTIARY }}>
          Voice settings are only available in the desktop app.
        </p>
      </div></div>
    );
  }

  return (
    <div style={PAGE_ROOT}>
      <div style={GLASS_SHELL}>
        <div style={FROST_LAYER} aria-hidden />

        {/* Sidebar */}
        <aside style={{
          position: 'relative', zIndex: 1, width: 188, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: SIDEBAR_BG, borderRight: `1px solid ${GLASS_BORDER_SUBTLE}`,
        }}>
          {/* Traffic lights (drag region) */}
          <div onMouseDown={startDrag} style={{ display: 'flex', gap: 8, padding: '13px 14px 0' }}>
            <CloseDot />
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: TL_MIN }} />
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: TL_ZOOM }} />
          </div>
          {/* Brand (drag region) */}
          <div onMouseDown={startDrag} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            padding: '22px 18px 18px', borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}`,
          }}>
            <BrandGlyph size={34} />
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.18em', color: TEXT_PRIMARY }}>O8 VOICE</span>
            {version ? <span style={{ fontSize: 10, color: TEXT_TERTIARY }}>v{version}</span> : null}
            <div style={{ marginTop: 2 }}><BrandWave /></div>
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
          <div onMouseDown={startDrag} style={{ height: 46, cursor: 'grab' }} aria-hidden />
          {tab === 'settings' ? <SettingsTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'dictionary' ? <DictionaryTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'snippets' ? <SnippetsTab prefs={prefs} setPref={setPref} /> : null}
          {tab === 'instructions' ? <InstructionsTab prefs={prefs} setPref={setPref} /> : null}
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
