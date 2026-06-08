'use client';

/**
 * VoiceTab — Voice / System-Dictation settings (system-wide Symon fold P4).
 *
 * Surfaces the macOS permission state for the global Fn-hotkey dictation path
 * (Accessibility / Input Monitoring / Fn-key binding), jump-to-Settings buttons
 * for granting, and the two background-presence toggles:
 *   - Start o8 at login (autostart, default ON)
 *   - Background mode — hide Dock icon, pill only (default OFF)
 *
 * All native state is read live through the Tauri bridge (isTauri() guarded).
 * Inline styles only, var(--t-*) tokens, raw-SVG icons (repo rule: no React
 * icon components inside the Tauri webview).
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  isTauri,
  accessibilityPermissionGranted,
  inputMonitoringGranted,
  fnKeyUsageType,
  openSystemSettings,
  autostartIsEnabled,
  autostartSet,
  backgroundModeIsEnabled,
  backgroundModeSet,
  voicePrefsGet,
  voicePrefsSet,
} from '@/lib/tauri/bridge';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  HairlineRule,
  RamsButton,
  SectionLabel,
  SettingsToggleButton,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';

// macOS System Settings deep-links.
const URL_ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const URL_INPUT_MONITORING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
const URL_KEYBOARD = 'x-apple.systempreferences:com.apple.preference.keyboard';

// ── Raw-SVG status glyphs (themed) ──

function CheckGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#d94f3a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function DashGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, opacity: 0.5 }}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// ── Permission status row ──

type PermState = 'granted' | 'denied' | 'unknown';

function PermissionRow({
  label,
  detail,
  state,
  buttonLabel,
  onOpen,
}: {
  label: string;
  detail: string;
  state: PermState;
  buttonLabel: string;
  onOpen: () => void;
}) {
  const statusText = state === 'granted' ? 'Granted' : state === 'denied' ? 'Needs grant' : 'Unknown';
  const statusColor = state === 'granted' ? '#22c55e' : state === 'denied' ? '#d94f3a' : RAMS_INK_QUIET;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        paddingTop: 12,
        paddingBottom: 12,
      }}
    >
      <span style={{ display: 'inline-flex', color: RAMS_INK_QUIET }}>
        {state === 'granted' ? <CheckGlyph /> : state === 'denied' ? <XGlyph /> : <DashGlyph />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {label}
        </div>
        <div style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-faint)', lineHeight: 1.45, marginTop: 2 }}>
          {detail}
        </div>
      </div>
      <span
        style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: statusColor,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {statusText}
      </span>
      <RamsButton variant="ghost" onClick={onOpen}>{buttonLabel}</RamsButton>
    </div>
  );
}

// ── Toggle row ──

function ToggleRow({
  label,
  detail,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        paddingTop: 12,
        paddingBottom: 12,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {label}
        </div>
        <div style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-faint)', lineHeight: 1.45, marginTop: 2, maxWidth: 520 }}>
          {detail}
        </div>
      </div>
      <SettingsToggleButton checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: APP_FONT_STACK,
  fontSize: 13,
  fontWeight: 300,
  lineHeight: 1.5,
  color: 'var(--t-text)',
  background: 'var(--t-input-bg)',
  border: '1px solid var(--t-border)',
  borderRadius: 10,
  paddingTop: 10,
  paddingBottom: 10,
  paddingLeft: 12,
  paddingRight: 12,
  resize: 'vertical',
  outline: 'none',
};

export function VoiceTab() {
  const tauri = isTauri();

  const [accessibility, setAccessibility] = useState<PermState>('unknown');
  const [inputMonitoring, setInputMonitoring] = useState<PermState>('unknown');
  // null = unread; number = AppleFnUsageType (0 = Do Nothing, the value we want).
  const [fnUsage, setFnUsage] = useState<number | null | undefined>(undefined);
  const [autostart, setAutostart] = useState(false);
  const [bgMode, setBgMode] = useState(false);
  // Voice feedback + polish prefs (~/.o8/dictation.json, #1209).
  const [ducking, setDucking] = useState(true);
  const [sounds, setSounds] = useState(true);
  const [dictionary, setDictionary] = useState('');
  const [instructions, setInstructions] = useState('');

  const refreshPermissions = useCallback(async () => {
    if (!tauri) return;
    const [acc, input, fn] = await Promise.all([
      accessibilityPermissionGranted(),
      inputMonitoringGranted(),
      fnKeyUsageType(),
    ]);
    setAccessibility(acc ? 'granted' : 'denied');
    setInputMonitoring(input ? 'granted' : 'denied');
    setFnUsage(fn);
  }, [tauri]);

  const loadAll = useCallback(async () => {
    if (!tauri) return;
    const [, auto, bg, prefs] = await Promise.all([
      refreshPermissions(),
      autostartIsEnabled(),
      backgroundModeIsEnabled(),
      voicePrefsGet(),
    ]);
    setAutostart(auto);
    setBgMode(bg);
    if (prefs) {
      setDucking(prefs.ducking_enabled !== false); // default on
      setSounds(prefs.sounds_enabled !== false);
      setDictionary(Array.isArray(prefs.dictionary) ? (prefs.dictionary as string[]).join('\n') : '');
      setInstructions(typeof prefs.polish_instructions === 'string' ? prefs.polish_instructions : '');
    }
  }, [tauri, refreshPermissions]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // Re-poll permissions when the window regains focus — the user typically
  // grants in System Settings then tabs back, so the status should update.
  useEffect(() => {
    if (!tauri) return;
    const onFocus = () => { void refreshPermissions(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [tauri, refreshPermissions]);

  const handleAutostart = useCallback((next: boolean) => {
    setAutostart(next);
    void autostartSet(next).then(setAutostart);
  }, []);

  const handleBgMode = useCallback((next: boolean) => {
    setBgMode(next);
    void backgroundModeSet(next).then(setBgMode);
  }, []);

  const handleDucking = useCallback((next: boolean) => {
    setDucking(next);
    void voicePrefsSet('ducking_enabled', next);
  }, []);

  const handleSounds = useCallback((next: boolean) => {
    setSounds(next);
    void voicePrefsSet('sounds_enabled', next);
  }, []);

  // Persist on blur — the prefs file is mtime-cached so the next dictation picks
  // it up without a relaunch.
  const handleDictionaryBlur = useCallback(() => {
    const arr = dictionary.split('\n').map((s) => s.trim()).filter(Boolean);
    void voicePrefsSet('dictionary', arr);
  }, [dictionary]);

  const handleInstructionsBlur = useCallback(() => {
    void voicePrefsSet('polish_instructions', instructions.trim());
  }, [instructions]);

  // Fn hijack present when AppleFnUsageType is unset (treated as 3 = Start
  // Dictation) or set to anything other than 0 = Do Nothing.
  const fnHijacked = fnUsage !== undefined && fnUsage !== 0;
  // For the permission row, "granted" only when explicitly set to 0.
  const fnState: PermState = fnUsage === undefined ? 'unknown' : fnUsage === 0 ? 'granted' : 'denied';

  return (
    <div
      style={{
        paddingTop: 8,
        paddingLeft: 8,
        paddingRight: 32,
        paddingBottom: 40,
        maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
        fontFamily: APP_FONT_STACK,
      }}
    >
      <TabBreadcrumb tab="voice" />
      <TabHeading
        title="voice"
        subtitle="Hold the Fn key in any app to dictate — o8 transcribes, polishes, and pastes the text at the caret. These permissions and toggles control the system-wide voice path."
      />

      {!tauri ? (
        <p style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text-faint)', lineHeight: 1.55, maxWidth: 620 }}>
          Voice and system-dictation settings are only available in the desktop app.
        </p>
      ) : (
        <>
          <section>
            <SectionLabel number="01">PERMISSIONS</SectionLabel>
            <p
              style={{
                margin: 0,
                marginTop: 4,
                marginBottom: 6,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--t-text-secondary)',
                maxWidth: 620,
              }}
            >
              The global Fn hotkey needs two separate macOS grants. Without Input
              Monitoring the key does nothing — with no error. Grant in System
              Settings, then tab back here to re-check.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <PermissionRow
                label="Accessibility"
                detail="Lets o8 observe the focused window so dictation lands in the right app."
                state={accessibility}
                buttonLabel="Open Accessibility Settings"
                onOpen={() => { void openSystemSettings(URL_ACCESSIBILITY); }}
              />
              <HairlineRule />
              <PermissionRow
                label="Input Monitoring"
                detail="Required for the Fn key tap to receive events. Separate from and stricter than Accessibility."
                state={inputMonitoring}
                buttonLabel="Open Input Monitoring Settings"
                onOpen={() => { void openSystemSettings(URL_INPUT_MONITORING); }}
              />
              <HairlineRule />
              <PermissionRow
                label="Fn key binding"
                detail={'Set "Press 🌐 key to" → "Do Nothing" so Apple Dictation does not intercept Fn before o8.'}
                state={fnState}
                buttonLabel="Open Keyboard Settings"
                onOpen={() => { void openSystemSettings(URL_KEYBOARD); }}
              />
            </div>

            {fnHijacked ? (
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  paddingBottom: 12,
                  paddingLeft: 14,
                  paddingRight: 14,
                  borderRadius: 10,
                  border: '1px solid rgba(217, 79, 58, 0.28)',
                  background: 'rgba(217, 79, 58, 0.08)',
                  fontSize: 12.5,
                  fontWeight: 300,
                  lineHeight: 1.5,
                  color: 'var(--t-text-secondary)',
                  maxWidth: 620,
                }}
              >
                <strong style={{ fontWeight: 500, color: 'var(--t-text)' }}>The Fn key is currently hijacked.</strong>{' '}
                macOS is set to start Apple Dictation on Fn, which intercepts the
                press before o8 can react. Open Keyboard Settings and set
                &ldquo;Press 🌐 key to&rdquo; to &ldquo;Do Nothing&rdquo;.
              </div>
            ) : null}

            <div style={{ marginTop: 16 }}>
              <RamsButton variant="ghost" onClick={() => { void refreshPermissions(); }}>
                Re-check permissions
              </RamsButton>
            </div>

            <div style={{ marginTop: 28 }}>
              <HairlineRule />
            </div>
          </section>

          <section style={{ marginTop: 32 }}>
            <SectionLabel number="02">BACKGROUND PRESENCE</SectionLabel>
            <p
              style={{
                margin: 0,
                marginTop: 4,
                marginBottom: 10,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--t-text-secondary)',
                maxWidth: 620,
              }}
            >
              Keep o8 resident so the pill and Fn hotkey work without opening the
              app. The menu-bar tray is always the way back to the window.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ToggleRow
                label="Start o8 at login"
                detail="Launch o8 automatically when you log in, so dictation is ready from the moment you sit down."
                checked={autostart}
                onChange={handleAutostart}
              />
              <HairlineRule />
              <ToggleRow
                label="Background mode — hide Dock icon, pill only"
                detail="Run o8 as a pure menu-bar app: no Dock icon, just the dictation pill. Click the tray icon to bring the window — and the Dock icon — back."
                checked={bgMode}
                onChange={handleBgMode}
              />
            </div>
          </section>

          <section style={{ marginTop: 32 }}>
            <SectionLabel number="03">FEEDBACK</SectionLabel>
            <p
              style={{
                margin: 0,
                marginTop: 4,
                marginBottom: 10,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--t-text-secondary)',
                maxWidth: 620,
              }}
            >
              How o8 responds while you dictate and while it speaks back.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ToggleRow
                label="Dim other audio while dictating"
                detail="Lower the system volume to 20% while you hold Fn, so the mic hears you over whatever's playing — including o8's own voice when you talk back mid-answer."
                checked={ducking}
                onChange={handleDucking}
              />
              <HairlineRule />
              <ToggleRow
                label="Sound cues"
                detail="Short tones for listen start/stop, paste landed, and read-aloud start/finish."
                checked={sounds}
                onChange={handleSounds}
              />
            </div>
          </section>

          <section style={{ marginTop: 32 }}>
            <SectionLabel number="04">POLISH</SectionLabel>
            <p
              style={{
                margin: 0,
                marginTop: 4,
                marginBottom: 12,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--t-text-secondary)',
                maxWidth: 620,
              }}
            >
              Shape how o8 cleans up your dictation. Both apply on the next dictation — no relaunch.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 620 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.01em', marginBottom: 6 }}>
                  Custom dictionary
                </div>
                <textarea
                  value={dictionary}
                  onChange={(e) => setDictionary(e.target.value)}
                  onBlur={handleDictionaryBlur}
                  placeholder="One per line — proper nouns o8 should always spell right (Karpathy, Tauri, o8…)"
                  rows={4}
                  style={textareaStyle}
                />
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.01em', marginBottom: 6 }}>
                  Polish instructions
                </div>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  onBlur={handleInstructionsBlur}
                  placeholder="Guidance for cleanup — e.g. 'Keep my casual tone; always capitalize iOS; expand abbreviations.'"
                  rows={3}
                  style={textareaStyle}
                />
              </div>
            </div>
          </section>
        </>
      )}

      <p
        style={{
          marginTop: 36,
          fontSize: 11,
          fontWeight: 300,
          color: RAMS_INK_QUIET,
          fontFamily: MONO_FONT_STACK,
          letterSpacing: '0.04em',
        }}
      >
        <span style={{ color: RAMS_ACCENT }}>FN</span> &nbsp; Hold to dictate, release to paste.
      </p>
    </div>
  );
}
