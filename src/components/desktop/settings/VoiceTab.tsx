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
  agentGetEscalation,
  agentSetEscalation,
} from '@/lib/tauri/bridge';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  MicIcon,
  SettingsSegmented,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow, RowDivider, ValuePill } from './grouped';
import {
  DEFAULT_DICTATION_INPUT_MODE,
  readDictationInputMode,
  subscribeDictationInputMode,
  writeDictationInputMode,
  type DictationInputMode,
} from '@/lib/appearance/dictation-input-mode';
import { useSyncExternalStore } from 'react';
import { VoiceHistorySection } from './VoiceHistorySection';

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

// ── Permission state ──

type PermState = 'granted' | 'denied' | 'unknown';

function permGlyph(state: PermState) {
  return state === 'granted' ? <CheckGlyph /> : state === 'denied' ? <XGlyph /> : <DashGlyph />;
}

function permPill(state: PermState) {
  return state === 'granted'
    ? <ValuePill tone="success">Granted</ValuePill>
    : state === 'denied'
      ? <ValuePill tone="destructive">Needs grant</ValuePill>
      : <ValuePill>Unknown</ValuePill>;
}

// ── Small raw-SVG glyphs for row icon tiles ──

function PowerIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <line x1="7" y1="20" x2="17" y2="20" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function BrainGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

const noopSubscribe = () => () => {};
const dictationModeFallback = (): DictationInputMode => DEFAULT_DICTATION_INPUT_MODE;

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
  // Two-tier brain escalation policy (~/.o8/agent_models.json via the router).
  const [escalation, setEscalation] = useState<'off' | 'auto' | 'deep'>('auto');
  const dictationMode = useSyncExternalStore(
    typeof window !== 'undefined' ? subscribeDictationInputMode : noopSubscribe,
    typeof window !== 'undefined' ? readDictationInputMode : dictationModeFallback,
    dictationModeFallback,
  );

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
    const [, auto, bg, prefs, esc] = await Promise.all([
      refreshPermissions(),
      autostartIsEnabled(),
      backgroundModeIsEnabled(),
      voicePrefsGet(),
      agentGetEscalation().catch(() => 'auto'),
    ]);
    setAutostart(auto);
    setBgMode(bg);
    if (prefs) {
      setDucking(prefs.ducking_enabled !== false); // default on
      setSounds(prefs.sounds_enabled !== false);
      setDictionary(Array.isArray(prefs.dictionary) ? (prefs.dictionary as string[]).join('\n') : '');
      setInstructions(typeof prefs.polish_instructions === 'string' ? prefs.polish_instructions : '');
    }
    if (esc === 'off' || esc === 'auto' || esc === 'deep') setEscalation(esc);
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

  const handleEscalation = useCallback((next: 'off' | 'auto' | 'deep') => {
    setEscalation(next);
    void agentSetEscalation(next);
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
            <SettingsGroup
              header="Permissions"
              footnote="The global Fn hotkey needs two separate macOS grants — without Input Monitoring the key does nothing, with no error. Click a row to open the right System Settings pane; the status re-checks when you tab back."
            >
              <SettingsRow
                icon={permGlyph(accessibility)}
                label="Accessibility"
                subtitle="Lets o8 see the focused window so dictation lands in the right app"
                accessory={permPill(accessibility)}
                chevron
                onPress={() => { void openSystemSettings(URL_ACCESSIBILITY); }}
                divider
              />
              <SettingsRow
                icon={permGlyph(inputMonitoring)}
                label="Input Monitoring"
                subtitle="Required for the Fn key to receive events — stricter than Accessibility"
                accessory={permPill(inputMonitoring)}
                chevron
                onPress={() => { void openSystemSettings(URL_INPUT_MONITORING); }}
                divider
              />
              <SettingsRow
                icon={permGlyph(fnState)}
                label="Fn key binding"
                subtitle={'Set "Press 🌐 key to" → "Do Nothing" so Apple Dictation doesn\'t intercept'}
                accessory={permPill(fnState)}
                chevron
                onPress={() => { void openSystemSettings(URL_KEYBOARD); }}
              />
            </SettingsGroup>

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
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Background presence"
              footnote="Keep o8 resident so the pill and Fn hotkey work without the window open. The menu-bar tray is always the way back."
            >
              <SettingsRow
                icon={<PowerIcon />}
                label="Start o8 at login"
                subtitle="Dictation ready from the moment you sit down"
                checked={autostart}
                onToggle={handleAutostart}
                divider
              />
              <SettingsRow
                icon={<DockIcon />}
                label="Background mode"
                subtitle="Hide the Dock icon — pure menu-bar app, pill only"
                checked={bgMode}
                onToggle={handleBgMode}
              />
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Dictation"
              footnote="Tap: click the mic to start, click again to send. Hold: keep the mic (or Ctrl+Z) pressed while you speak. Audio dimming drops system volume to 20% while you hold Fn so the mic hears you over whatever's playing."
            >
              <SettingsRow
                icon={<MicIcon />}
                label="Mic input"
                subtitle="How the mic button next to Send behaves"
                accessory={
                  <SettingsSegmented
                    value={dictationMode}
                    onChange={(v) => writeDictationInputMode(v as DictationInputMode)}
                    options={[
                      { value: 'toggle', label: 'Tap' },
                      { value: 'hold', label: 'Hold' },
                    ]}
                  />
                }
                divider
              />
              <SettingsRow
                icon={<VolumeIcon />}
                label="Dim other audio while dictating"
                checked={ducking}
                onToggle={handleDucking}
                divider
              />
              <SettingsRow
                icon={<BellIcon />}
                label="Sound cues"
                subtitle="Tones for listen start/stop, paste landed, read-aloud"
                checked={sounds}
                onToggle={handleSounds}
              />
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Polish"
              footnote="Both apply on the next dictation — no relaunch."
            >
              <div style={{ paddingTop: 12, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
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
              <RowDivider />
              <div style={{ paddingTop: 12, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
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
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Voice brain"
              footnote="Auto hands heavy, multi-step requests to a deeper background brain — it answers you instantly, keeps working while you talk, then reports back. Deep also hands off medium tasks. Uses your Claude subscription."
            >
              <SettingsRow
                icon={<BrainGlyph />}
                label="Escalation"
                subtitle="When to hand a request to the deeper brain"
                accessory={
                  <SettingsSegmented
                    value={escalation}
                    onChange={(v) => handleEscalation(v as 'off' | 'auto' | 'deep')}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'auto', label: 'Auto' },
                      { value: 'deep', label: 'Deep' },
                    ]}
                  />
                }
              />
            </SettingsGroup>
          </section>

          <VoiceHistorySection />
        </>
      )}

      <p
        style={{
          marginTop: 36,
          fontSize: 11,
          fontWeight: 300,
          color: RAMS_INK_QUIET,
          fontFamily: APP_FONT_STACK,
          letterSpacing: '0.04em',
        }}
      >
        <span style={{ color: RAMS_ACCENT }}>FN</span> &nbsp; Hold to dictate, release to paste.
      </p>
    </div>
  );
}
