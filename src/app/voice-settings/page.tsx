'use client';

/**
 * /voice-settings — the standalone Voice settings window, styled as Symon's
 * frosted-GLASS modal (parity with the acquired app), NOT o8's settings chrome.
 *
 * The Tauri "voice-settings" window is transparent + decorations:false, so this
 * CSS glass card IS the window. Opened by double-tapping the dock — works even
 * when the main o8 window is closed. Self-contained: inline styles only, literal
 * Symon rgba (dark/midnight tone), raw-SVG icons, no var(--t-*) tokens, no React
 * icon components. Reads/writes via the same bridge fns as the main VoiceTab.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  isTauri,
  voicePrefsGet,
  voicePrefsSet,
  dictationHistoryGet,
  dictationHistoryDelete,
  dictationHistoryClear,
  accessibilityPermissionGranted,
  inputMonitoringGranted,
  fnKeyUsageType,
  openSystemSettings,
  type DictationHistoryEntry,
} from '@/lib/tauri/bridge';

export const dynamic = 'force-dynamic';

// ── Symon palette (dark/midnight tone, literal) ──
const TEXT_PRIMARY = 'rgba(255,255,255,0.95)';
const TEXT_SECONDARY = 'rgba(255,255,255,0.6)';
const TEXT_TERTIARY = 'rgba(255,255,255,0.4)';
const ACCENT = '#4058FF';
const ACCENT_LIGHT = '#6B7FFF';
const GLASS_BG = 'rgba(255,255,255,0.06)';
const GLASS_BG_HOVER = 'rgba(255,255,255,0.1)';
const GLASS_BORDER_SUBTLE = 'rgba(255,255,255,0.08)';
const TRANS_FAST = '150ms cubic-bezier(0.25,0.1,0.25,1)';
const SF = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

const URL_ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const URL_INPUT_MONITORING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
const URL_KEYBOARD = 'x-apple.systempreferences:com.apple.preference.keyboard';

// ── Shell / chrome ──
const PAGE_ROOT: CSSProperties = {
  width: '100vw', height: '100vh', margin: 0, padding: 0,
  background: 'transparent', overflow: 'hidden', fontFamily: SF,
};
const GLASS_SHELL: CSSProperties = {
  position: 'relative', isolation: 'isolate',
  display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
  borderRadius: 22, overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.12)',
  background:
    'radial-gradient(circle at top left, rgba(64,88,255,0.22), transparent 38%),'
    + ' linear-gradient(180deg, rgba(10,16,26,0.88), rgba(9,14,24,0.78))',
  backdropFilter: 'blur(28px) saturate(1.08)',
  WebkitBackdropFilter: 'blur(28px) saturate(1.08)',
  boxShadow: '0 24px 60px rgba(2,6,23,0.34)',
};
const FROST_LAYER: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
  background: 'linear-gradient(180deg, rgba(10,16,26,0.72), rgba(9,14,24,0.62))',
  backdropFilter: 'blur(30px) saturate(1.08)',
  WebkitBackdropFilter: 'blur(30px) saturate(1.08)',
};
const TITLE_ROW: CSSProperties = {
  position: 'relative', zIndex: 1,
  display: 'flex', alignItems: 'center', gap: 8, height: 46,
  paddingLeft: 16, paddingRight: 16, flexShrink: 0,
  borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}`, cursor: 'grab',
};
const TITLE_TEXT: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase',
  color: TEXT_SECONDARY, userSelect: 'none', marginLeft: 4,
};
const CONTENT_SCROLL: CSSProperties = {
  position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto', overflowX: 'hidden',
  paddingLeft: 28, paddingRight: 28, paddingBottom: 28, paddingTop: 4,
  background:
    'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0) 0 0 / 22px 22px,'
    + ' linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))',
};

// ── Controls ──
const SECTION_LABEL: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 10, fontWeight: 600, color: TEXT_SECONDARY,
  textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 10, marginTop: 24,
};
const SECTION_DESC: CSSProperties = {
  fontSize: 12, color: TEXT_TERTIARY, lineHeight: 1.45, marginTop: -2, marginBottom: 10, maxWidth: 480,
};
const SETTING_ROW_TOGGLE: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
  paddingTop: 10, paddingBottom: 10, borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}`,
};
const SETTING_LABEL: CSSProperties = { fontSize: 13, color: TEXT_PRIMARY, fontWeight: 400 };
const SETTING_DESCRIPTION: CSSProperties = {
  fontSize: 12, color: TEXT_TERTIARY, lineHeight: 1.45, marginTop: 4, maxWidth: 380,
};
const TEXTAREA_BASE: CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14,
  background: GLASS_BG, border: `1px solid ${GLASS_BORDER_SUBTLE}`,
  borderRadius: 12, color: TEXT_PRIMARY, fontSize: 13, fontFamily: 'inherit',
  lineHeight: 1.6, outline: 'none', resize: 'vertical', minHeight: 84,
  transition: `border-color ${TRANS_FAST}, box-shadow ${TRANS_FAST}, background ${TRANS_FAST}`,
};
const BTN_GHOST: CSSProperties = {
  height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 8,
  border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: 'transparent',
  color: TEXT_SECONDARY, fontSize: 11, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
  transition: `background ${TRANS_FAST}, color ${TRANS_FAST}`,
};
const DIVIDER: CSSProperties = { height: 1, background: GLASS_BORDER_SUBTLE, border: 'none', margin: 0 };
const STATUS_PILL = (granted: boolean): CSSProperties => ({
  display: 'inline-block', padding: '1px 7px', borderRadius: 999,
  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  border: granted ? '1px solid rgba(34,197,94,0.45)' : '1px solid rgba(248,113,113,0.45)',
  background: granted ? 'rgba(34,197,94,0.14)' : 'rgba(248,113,113,0.14)',
  color: granted ? 'rgb(74,222,128)' : 'rgb(248,113,113)',
});
const TOGGLE_TRACK = (on: boolean, focus: boolean): CSSProperties => ({
  position: 'relative', width: 44, height: 24, borderRadius: 12,
  background: on ? ACCENT : 'rgba(255,255,255,0.2)', cursor: 'pointer',
  transition: 'background 200ms ease', flexShrink: 0, outline: 'none', marginTop: 1,
  border: 'none', padding: 0, boxShadow: focus ? '0 0 0 2px rgba(64,88,255,0.5)' : 'none',
});
const TOGGLE_KNOB = (on: boolean): CSSProperties => ({
  position: 'absolute', top: 2, left: 2, width: 20, height: 20, borderRadius: '50%',
  background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  transition: 'transform 200ms ease', transform: on ? 'translateX(20px)' : 'translateX(0)',
});

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [focus, setFocus] = useState(false);
  return (
    <button
      type="button" role="switch" aria-checked={checked} style={TOGGLE_TRACK(checked, focus)}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onClick={() => onChange(!checked)}
    >
      <span style={TOGGLE_KNOB(checked)} />
    </button>
  );
}

function ToggleRow({ label, detail, checked, onChange }: {
  label: string; detail: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div style={SETTING_ROW_TOGGLE}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={SETTING_LABEL}>{label}</div>
        <div style={SETTING_DESCRIPTION}>{detail}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function GhostButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...BTN_GHOST, background: hover ? GLASS_BG_HOVER : 'transparent', color: hover ? TEXT_PRIMARY : TEXT_SECONDARY }}
    >
      {label}
    </button>
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={SECTION_LABEL}>
      <span style={{ color: ACCENT, display: 'flex', alignItems: 'center', opacity: 0.9 }}>{icon}</span>
      {children}
    </div>
  );
}

const ICON_FEEDBACK = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
  </svg>
);
const ICON_POLISH = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
  </svg>
);
const ICON_HISTORY = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);
const ICON_SHIELD = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
  </svg>
);

function relativeTime(tsSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  const d = new Date(tsSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function appName(bundleId: string): string {
  if (!bundleId) return '';
  const parts = bundleId.split('.');
  const last = parts[parts.length - 1] || bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function TitleRow({ onClose }: { onClose: () => void }) {
  const [hover, setHover] = useState(false);
  const onDrag = async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().startDragging(); }
    catch { /* noop */ }
  };
  return (
    <div style={TITLE_ROW} onMouseDown={onDrag}>
      <button
        type="button" aria-label="Close"
        onMouseDown={(e) => e.stopPropagation()} onClick={onClose}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          width: 12, height: 12, borderRadius: '50%', border: 'none',
          background: hover ? '#FF3B30' : '#FF5F57', cursor: 'pointer', padding: 0, flexShrink: 0,
        }}
      />
      <span style={TITLE_TEXT}>Voice</span>
    </div>
  );
}

function HistoryRow({ entry, copied, onCopy, onDelete }: {
  entry: DictationHistoryEntry; copied: boolean;
  onCopy: (id: string, text: string) => void; onDelete: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const app = appName(entry.app);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', paddingTop: 11, paddingBottom: 11 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: entry.mode === 'ask' ? ACCENT_LIGHT : TEXT_TERTIARY }}>
          {entry.mode.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>{relativeTime(entry.ts)}</span>
        {app ? <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>· {app}</span> : null}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, opacity: hover || copied ? 1 : 0, transition: `opacity ${TRANS_FAST}` }}>
          <button
            type="button" aria-label={copied ? 'Copied' : 'Copy text'} onClick={() => onCopy(entry.id, entry.text)}
            style={{ ...BTN_GHOST, height: 22, fontSize: 9.5, letterSpacing: '0.04em', color: copied ? 'rgb(74,222,128)' : TEXT_SECONDARY }}
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
          <button
            type="button" aria-label="Delete entry" onClick={() => onDelete(entry.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22,
              borderRadius: 6, border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: 'transparent',
              color: TEXT_TERTIARY, cursor: 'pointer', padding: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
      <div style={{ fontSize: 13, color: TEXT_PRIMARY, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>
        {entry.text}
      </div>
    </div>
  );
}

type PermState = 'granted' | 'denied' | 'unknown';

export default function VoiceSettingsPage() {
  const tauri = isTauri();
  const [ducking, setDucking] = useState(true);
  const [sounds, setSounds] = useState(true);
  const [dictionary, setDictionary] = useState('');
  const [instructions, setInstructions] = useState('');
  const [history, setHistory] = useState<DictationHistoryEntry[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [acc, setAcc] = useState<PermState>('unknown');
  const [input, setInput] = useState<PermState>('unknown');
  const [fn, setFn] = useState<number | null | undefined>(undefined);
  const [dictFocus, setDictFocus] = useState(false);
  const [instrFocus, setInstrFocus] = useState(false);

  const loadPrefs = useCallback(async () => {
    if (!tauri) return;
    const prefs = await voicePrefsGet();
    if (prefs) {
      setDucking(prefs.ducking_enabled !== false);
      setSounds(prefs.sounds_enabled !== false);
      setDictionary(Array.isArray(prefs.dictionary) ? (prefs.dictionary as string[]).join('\n') : '');
      setInstructions(typeof prefs.polish_instructions === 'string' ? prefs.polish_instructions : '');
    }
  }, [tauri]);

  const loadHistory = useCallback(async () => {
    if (!tauri) return;
    setHistory(await dictationHistoryGet());
  }, [tauri]);

  const loadPerms = useCallback(async () => {
    if (!tauri) return;
    const [a, i, f] = await Promise.all([accessibilityPermissionGranted(), inputMonitoringGranted(), fnKeyUsageType()]);
    setAcc(a ? 'granted' : 'denied');
    setInput(i ? 'granted' : 'denied');
    setFn(f);
  }, [tauri]);

  useEffect(() => { void loadPrefs(); void loadHistory(); void loadPerms(); }, [loadPrefs, loadHistory, loadPerms]);

  useEffect(() => {
    if (!tauri) return;
    const onFocus = () => { void loadHistory(); void loadPerms(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [tauri, loadHistory, loadPerms]);

  const handleClose = useCallback(async () => {
    try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().close(); }
    catch { /* noop */ }
  }, []);

  const handleDucking = (v: boolean) => { setDucking(v); void voicePrefsSet('ducking_enabled', v); };
  const handleSounds = (v: boolean) => { setSounds(v); void voicePrefsSet('sounds_enabled', v); };
  const handleDictBlur = () => { void voicePrefsSet('dictionary', dictionary.split('\n').map((s) => s.trim()).filter(Boolean)); };
  const handleInstrBlur = () => { void voicePrefsSet('polish_instructions', instructions.trim()); };

  const handleCopy = (id: string, text: string) => {
    if (!text.trim()) return;
    void navigator.clipboard?.writeText(text).catch(() => { /* noop */ });
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1400);
  };
  const handleDelete = async (id: string) => { await dictationHistoryDelete(id); setHistory((p) => p.filter((e) => e.id !== id)); };
  const handleClearAll = async () => { await dictationHistoryClear(); setHistory([]); };

  const fnGranted = fn === 0;
  const fnState: PermState = fn === undefined ? 'unknown' : fn === 0 ? 'granted' : 'denied';

  return (
    <div style={PAGE_ROOT}>
      <div style={GLASS_SHELL}>
        <div style={FROST_LAYER} aria-hidden />
        <TitleRow onClose={() => { void handleClose(); }} />
        <div style={CONTENT_SCROLL}>
          {!tauri ? (
            <p style={{ ...SECTION_DESC, marginTop: 24 }}>Voice settings are only available in the desktop app.</p>
          ) : (
            <>
              {/* Feedback */}
              <SectionLabel icon={ICON_FEEDBACK}>Feedback</SectionLabel>
              <ToggleRow
                label="Dim other audio while dictating"
                detail="Lower system volume to 20% while you hold Fn, so the mic hears you over whatever's playing — including o8's own voice."
                checked={ducking} onChange={handleDucking}
              />
              <ToggleRow
                label="Sound cues"
                detail="Short tones for listen start/stop, paste landed, and read-aloud."
                checked={sounds} onChange={handleSounds}
              />

              {/* Polish */}
              <SectionLabel icon={ICON_POLISH}>Polish</SectionLabel>
              <p style={SECTION_DESC}>Shape how o8 cleans up your dictation. Both apply on the next dictation — no relaunch.</p>
              <div style={{ marginBottom: 14 }}>
                <div style={{ ...SETTING_LABEL, marginBottom: 6 }}>Custom dictionary</div>
                <textarea
                  value={dictionary} onChange={(e) => setDictionary(e.target.value)}
                  onFocus={() => setDictFocus(true)} onBlur={() => { setDictFocus(false); handleDictBlur(); }}
                  placeholder="One per line — proper nouns o8 should always spell right"
                  rows={4}
                  style={{ ...TEXTAREA_BASE, borderColor: dictFocus ? ACCENT : GLASS_BORDER_SUBTLE, boxShadow: dictFocus ? '0 0 0 2px rgba(64,88,255,0.3)' : 'none', background: dictFocus ? GLASS_BG_HOVER : GLASS_BG }}
                />
              </div>
              <div>
                <div style={{ ...SETTING_LABEL, marginBottom: 6 }}>Polish instructions</div>
                <textarea
                  value={instructions} onChange={(e) => setInstructions(e.target.value)}
                  onFocus={() => setInstrFocus(true)} onBlur={() => { setInstrFocus(false); handleInstrBlur(); }}
                  placeholder="Guidance for cleanup — e.g. 'Keep my casual tone; always capitalize iOS.'"
                  rows={3}
                  style={{ ...TEXTAREA_BASE, borderColor: instrFocus ? ACCENT : GLASS_BORDER_SUBTLE, boxShadow: instrFocus ? '0 0 0 2px rgba(64,88,255,0.3)' : 'none', background: instrFocus ? GLASS_BG_HOVER : GLASS_BG }}
                />
              </div>

              {/* History */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <SectionLabel icon={ICON_HISTORY}>History</SectionLabel>
                <span style={{ marginLeft: 'auto', marginTop: 18, display: 'inline-flex', gap: 8 }}>
                  <GhostButton label="Refresh" onClick={() => { void loadHistory(); }} />
                  {history.length > 0 ? <GhostButton label="Clear all" onClick={() => { void handleClearAll(); }} /> : null}
                </span>
              </div>
              <p style={SECTION_DESC}>Everything you dictated or asked, newest first — your safety net when a paste lands in the wrong place. Stored locally.</p>
              {history.length === 0 ? (
                <p style={{ fontSize: 12.5, color: TEXT_TERTIARY, paddingTop: 6, paddingBottom: 6 }}>
                  No dictations yet — hold Fn and speak, and they&apos;ll show up here.
                </p>
              ) : (
                <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                  {history.map((entry, i) => (
                    <div key={entry.id}>
                      {i > 0 ? <hr style={DIVIDER} /> : null}
                      <HistoryRow entry={entry} copied={copiedId === entry.id} onCopy={handleCopy} onDelete={(id) => { void handleDelete(id); }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Permissions */}
              <SectionLabel icon={ICON_SHIELD}>Permissions</SectionLabel>
              <p style={SECTION_DESC}>The global Fn hotkey needs these macOS grants. Without Input Monitoring the key does nothing — silently.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <PermRow label="Accessibility" state={acc} onOpen={() => { void openSystemSettings(URL_ACCESSIBILITY); }} />
                <hr style={DIVIDER} />
                <PermRow label="Input Monitoring" state={input} onOpen={() => { void openSystemSettings(URL_INPUT_MONITORING); }} />
                <hr style={DIVIDER} />
                <PermRow label="Fn key binding" state={fnState} onOpen={() => { void openSystemSettings(URL_KEYBOARD); }} />
              </div>
              {fn !== undefined && !fnGranted ? (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.08)', fontSize: 12, lineHeight: 1.5, color: TEXT_SECONDARY }}>
                  <strong style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>The Fn key is hijacked.</strong>{' '}
                  macOS starts Apple Dictation on Fn. Open Keyboard Settings → set &ldquo;Press 🌐 key to&rdquo; → &ldquo;Do Nothing&rdquo;.
                </div>
              ) : null}
              <div style={{ marginTop: 14, marginBottom: 8 }}>
                <GhostButton label="Re-check permissions" onClick={() => { void loadPerms(); }} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PermRow({ label, state, onOpen }: { label: string; state: PermState; onOpen: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 10, paddingBottom: 10 }}>
      <span style={{ fontSize: 13, color: TEXT_PRIMARY, flex: 1 }}>{label}</span>
      <span style={STATUS_PILL(state === 'granted')}>{state === 'granted' ? 'Granted' : state === 'denied' ? 'Needs grant' : '—'}</span>
      <GhostButton label="Open" onClick={onOpen} />
    </div>
  );
}
