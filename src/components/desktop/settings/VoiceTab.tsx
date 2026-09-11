'use client';

/**
 * VoiceTab — Voice / System-Dictation settings (system-wide Symon fold P4).
 *
 * Surfaces the macOS permission state for the global Fn-hotkey dictation path
 * (Accessibility / Input Monitoring / Fn-key binding), jump-to-Settings buttons
 * for granting, and the dictation preferences. (Launch-at-login moved to the
 * General tab — it's an app-level setting, not a voice one.)
 *
 * All native state is read live through the Tauri bridge (isTauri() guarded).
 * Inline styles only, var(--t-*) tokens, raw-SVG icons (repo rule: no React
 * icon components inside the Tauri webview).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isTauri,
  accessibilityPermissionGranted,
  inputMonitoringGranted,
  fnKeyUsageType,
  openSystemSettings,
  openVoiceSettings,
  backgroundModeIsEnabled,
  backgroundModeSet,
  agentGetEscalation,
  agentSetEscalation,
  voicePrefsGet,
  voicePrefsSet,
  externalKeyboardFnState,
  symonBrainState,
  type ExternalKeyboardFnState,
  type SymonBrainState,
} from '@/lib/tauri/bridge';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  MicIcon,
  SettingsSegmented,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import {
  DEFAULT_DICTATION_INPUT_MODE,
  readDictationInputMode,
  subscribeDictationInputMode,
  writeDictationInputMode,
  type DictationInputMode,
} from '@/lib/appearance/dictation-input-mode';
import { useSyncExternalStore } from 'react';
import { SymonAttentionSettingsSection } from './SymonAttentionSettingsSection';

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

function SparkleIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 3l1.8 5.4L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.6L12 3z" />
    </svg>
  );
}

function CaptionsIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <line x1="7" y1="15" x2="11" y2="15" />
      <line x1="14" y1="15" x2="17" y2="15" />
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

export function VoiceTab() {
  const tauri = isTauri();

  const [accessibility, setAccessibility] = useState<PermState>('unknown');
  const [inputMonitoring, setInputMonitoring] = useState<PermState>('unknown');
  // null = unread; number = AppleFnUsageType (0 = Do Nothing, the value we want).
  const [fnUsage, setFnUsage] = useState<number | null | undefined>(undefined);
  // Two-tier brain escalation policy (~/.o8/agent_models.json via the router).
  const [escalation, setEscalation] = useState<'off' | 'auto' | 'deep'>('auto');
  // Groq BYOK for fast transcription (free tier). The config read strips the
  // secret; `groq_api_key_set` is the redacted presence flag.
  const [groqKeySet, setGroqKeySet] = useState(false);
  const [groqKeyInput, setGroqKeyInput] = useState('');
  const [groqKeySaving, setGroqKeySaving] = useState(false);
  const [partialsSurface, setPartialsSurface] = useState<'caret' | 'hud' | 'off'>('caret');
  const [leftControlAsFn, setLeftControlAsFn] = useState(false);
  // #2158: the EFFECTIVE remap state — the pref ANDed with "a non-Apple external
  // keyboard is attached". Null until the first read (or outside Tauri).
  const [externalFn, setExternalFn] = useState<ExternalKeyboardFnState | null>(null);
  // #2156: the Symon brain seat — the stored provider/tier/model pin plus the
  // seat the native planner registry resolves right now.
  const [brain, setBrain] = useState<SymonBrainState | null>(null);
  const [brainModelInput, setBrainModelInput] = useState('');
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
    const [, bg, esc, prefs] = await Promise.all([
      refreshPermissions(),
      backgroundModeIsEnabled(),
      agentGetEscalation().catch(() => 'auto'),
      voicePrefsGet().catch(() => null),
    ]);
    setGroqKeySet(Boolean(prefs && (prefs as Record<string, unknown>).groq_api_key_set));
    const savedSurface = prefs
      && (prefs as Record<string, unknown>).dictation_partials_surface;
    setPartialsSurface(savedSurface === 'hud' || savedSurface === 'off' ? savedSurface : 'caret');
    setLeftControlAsFn(
      Boolean(prefs && (prefs as Record<string, unknown>).external_symon_left_control === true),
    );
    setExternalFn(await externalKeyboardFnState().catch(() => null));
    const nextBrain = await symonBrainState().catch(() => null);
    setBrain(nextBrain);
    setBrainModelInput(nextBrain?.model ?? '');
    // Background mode was retired from the UI (operator, 2026-07-06) — self-heal
    // any stuck-on state so nobody is left with a hidden Dock icon and no way back.
    if (bg) void backgroundModeSet(false);
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

  // #2158: the native watcher re-reads the attached keyboards every couple of
  // seconds, so plugging or unplugging a board changes the remap with no UI
  // action. Poll while the tab is open so the status line under the toggle
  // tracks it, and refresh on focus like the permission rows do.
  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    const read = async () => {
      const next = await externalKeyboardFnState().catch(() => null);
      if (cancelled) return;
      setExternalFn(next);
      // Native truth wins over the optimistic segment value, so a pref written
      // from the standalone voice-settings window shows up here too.
      if (next) setLeftControlAsFn(next.enabled);
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 3000);
    const onFocus = () => { void read(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [tauri]);

  const handleEscalation = useCallback((next: 'off' | 'auto' | 'deep') => {
    setEscalation(next);
    void agentSetEscalation(next);
  }, []);

  const handlePartialsSurface = useCallback((next: 'caret' | 'hud' | 'off') => {
    setPartialsSurface(next);
    void voicePrefsSet('dictation_partials_surface', next);
  }, []);

  const handleLeftControlAsFn = useCallback(async (next: 'off' | 'left_control') => {
    const enabled = next === 'left_control';
    setLeftControlAsFn(enabled);
    await voicePrefsSet('external_symon_left_control', enabled);
    // The native side re-evaluates the attached keyboards on this write, so the
    // status line can settle immediately instead of waiting for the next poll.
    setExternalFn(await externalKeyboardFnState().catch(() => null));
  }, []);

  // Every brain write goes through the voice pref store and then re-reads the
  // native seat, so the status line shows what the NEXT task will actually run
  // — including a pick whose CLI is missing.
  const writeBrainPref = useCallback(async (key: string, value: string) => {
    await voicePrefsSet(key, value);
    setBrain(await symonBrainState().catch(() => null));
  }, []);

  const handleBrainProvider = useCallback((next: string) => {
    setBrain((current) => (current ? { ...current, provider: next } : current));
    void writeBrainPref('symon_brain_provider', next);
  }, [writeBrainPref]);

  const handleBrainTier = useCallback((next: string) => {
    setBrain((current) => (current ? { ...current, tier: next } : current));
    void writeBrainPref('symon_brain_tier', next);
  }, [writeBrainPref]);

  const handleBrainModel = useCallback(async () => {
    await writeBrainPref('symon_brain_model', brainModelInput.trim());
  }, [brainModelInput, writeBrainPref]);

  const handleGroqKeySave = useCallback(async () => {
    const key = groqKeyInput.trim();
    if (!key) return;
    setGroqKeySaving(true);
    try {
      await voicePrefsSet('groq_api_key', key);
      setGroqKeySet(true);
      setGroqKeyInput('');
    } finally {
      setGroqKeySaving(false);
    }
  }, [groqKeyInput]);

  const handleGroqKeyRemove = useCallback(async () => {
    setGroqKeySaving(true);
    try {
      await voicePrefsSet('groq_api_key', '');
      setGroqKeySet(false);
    } finally {
      setGroqKeySaving(false);
    }
  }, []);

  // Only an EXPLICIT non-zero AppleFnUsageType means Apple Dictation owns the
  // key. Unset (null) is machine-dependent — on machines where the tap works
  // fine with the key absent, treating unset as broken is a false negative
  // (operator hit this 2026-07-06). Unset renders quiet/neutral, never red.
  const fnHijacked = typeof fnUsage === 'number' && fnUsage !== 0;
  const fnState: PermState = fnUsage === 0 ? 'granted' : fnHijacked ? 'denied' : 'unknown';
  const fnPill = fnUsage === 0
    ? <ValuePill tone="success">Do Nothing</ValuePill>
    : fnHijacked
      ? <ValuePill tone="destructive">Needs change</ValuePill>
      : <ValuePill>Not set</ValuePill>;

  // #2156: the provider choices ARE the native planner registry — the panel
  // renders whatever adapters the Rust side registers rather than a second list
  // that can drift from it.
  const brainProviderOptions = useMemo(
    () => [
      { value: 'auto', label: 'Auto' },
      ...(brain?.adapters ?? []).map((adapter) => ({ value: adapter.id, label: adapter.label })),
    ],
    [brain],
  );
  const resolvedSeat = brain?.resolvedProvider
    ? [
      brain.resolvedLabel ?? brain.resolvedProvider,
      brain.resolvedModel ?? 'configured model',
      brain.resolvedEffort ?? 'default',
    ].join(' · ')
    : null;
  // Says what the NEXT task will run, so a pick whose CLI is missing reads as a
  // fallback instead of silently doing something else.
  const brainStatus = !brain
    ? 'Reading the installed agent CLIs…'
    : brain.detail
      ? brain.detail
      : brain.fellBackFrom
        ? `Not installed: ${brain.fellBackFrom} — falling back to ${resolvedSeat}`
        : `Resolved: ${resolvedSeat}`;
  const brainStatusTone = brain?.detail
    ? '#d94f3a'
    : brain?.fellBackFrom
      ? RAMS_ACCENT
      : 'var(--t-text-faint)';
  const brainModelPlaceholder = brain?.adapters.find(
    (adapter) => adapter.id === brain.resolvedProvider,
  )?.runtimeConfiguredModel
    ? 'provider/model'
    : 'model id';

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
      <TabHeading
        title="voice"
        subtitle="Hold Fn, or its external-keyboard substitute, for polished dictation. Double-tap for hands-free dictation. Hold Right Option to talk to Symon."
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
                subtitle={fnHijacked
                  ? 'Set "Press 🌐 key to" → "Do Nothing" so Apple Dictation doesn\'t intercept'
                  : '"Press 🌐 key to" in Keyboard Settings — only change if Fn dictation misfires'}
                accessory={fnPill}
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
              header="Dictation"
              footnote="Tap: click the mic to start, click again to send. Hold: keep the mic (or Ctrl+Z) pressed while you speak."
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
                icon={<CaptionsIcon />}
                label="Live dictation"
                subtitle="At caret streams into verified text fields and follows the insertion point; Screen keeps the original bottom bar"
                accessory={
                  <SettingsSegmented
                    value={partialsSurface}
                    onChange={(v) => handlePartialsSurface(v as 'caret' | 'hud' | 'off')}
                    options={[
                      { value: 'caret', label: 'At caret' },
                      { value: 'hud', label: 'Screen' },
                      { value: 'off', label: 'Off' },
                    ]}
                  />
                }
                divider
              />
              <SettingsRow
                icon={<MicIcon />}
                label="External keyboard Fn"
                subtitle={
                  <>
                    Makes bottom-left Control act as Fn — hold it to dictate, double-tap it for
                    hands-free. Only while a non-Apple external keyboard is attached, so Control
                    stays an ordinary modifier on Apple boards.
                    {leftControlAsFn ? (
                      <span
                        style={{
                          display: 'block',
                          marginTop: 4,
                          color: externalFn?.active ? RAMS_ACCENT : 'var(--t-text-faint)',
                        }}
                      >
                        {externalFn?.active
                          ? `Active: ${externalFn.keyboard ?? 'external keyboard'}`
                          : 'Waiting for an external non-Apple keyboard'}
                      </span>
                    ) : null}
                  </>
                }
                accessory={
                  <SettingsSegmented
                    value={leftControlAsFn ? 'left_control' : 'off'}
                    onChange={(v) => { void handleLeftControlAsFn(v as 'off' | 'left_control'); }}
                    options={[
                      { value: 'off', label: 'Fn only' },
                      { value: 'left_control', label: 'Bottom-left Ctrl' },
                    ]}
                  />
                }
              />
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Transcription"
              footnote="A free Groq key makes release-to-paste near-instant (their free tier easily covers one person's dictation). Keys stay in macOS Keychain and are sent only to Groq."
            >
              <SettingsRow
                icon={<MicIcon />}
                label="Groq API key"
                subtitle={groqKeySet
                  ? 'Key saved — fast transcription active. Paste a new key to replace it.'
                  : 'Free at console.groq.com/keys — paste it here'}
                accessory={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="password"
                      value={groqKeyInput}
                      placeholder={groqKeySet ? '••••••••' : 'gsk_...'}
                      onChange={(e) => setGroqKeyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleGroqKeySave(); }}
                      style={{
                        width: 180,
                        height: 26,
                        paddingLeft: 8,
                        paddingRight: 8,
                        fontSize: 12,
                        fontWeight: 300,
                        letterSpacing: '-0.1px',
                        fontFamily: APP_FONT_STACK,
                        color: 'var(--t-text)',
                        background: 'var(--t-input-bg)',
                        border: '1px solid var(--t-divider)',
                        borderRadius: 7,
                        outline: 'none',
                      }}
                    />
                    {groqKeyInput.trim() ? (
                      <button
                        type="button"
                        onClick={() => { void handleGroqKeySave(); }}
                        disabled={groqKeySaving}
                        style={{
                          height: 26,
                          paddingLeft: 10,
                          paddingRight: 10,
                          fontSize: 12,
                          fontWeight: 300,
                          letterSpacing: '-0.1px',
                          fontFamily: APP_FONT_STACK,
                          color: 'var(--t-text)',
                          background: 'var(--t-input-bg)',
                          border: '1px solid var(--t-divider)',
                          borderRadius: 7,
                          cursor: groqKeySaving ? 'default' : 'pointer',
                        }}
                      >
                        {groqKeySaving ? 'Saving…' : 'Save'}
                      </button>
                    ) : groqKeySet ? (
                      <button
                        type="button"
                        onClick={() => { void handleGroqKeyRemove(); }}
                        disabled={groqKeySaving}
                        style={{
                          height: 26,
                          paddingLeft: 10,
                          paddingRight: 10,
                          fontSize: 12,
                          fontWeight: 300,
                          letterSpacing: '-0.1px',
                          fontFamily: APP_FONT_STACK,
                          color: 'var(--t-text-muted)',
                          background: 'transparent',
                          border: '1px solid var(--t-divider)',
                          borderRadius: 7,
                          cursor: groqKeySaving ? 'default' : 'pointer',
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </span>
                }
              />
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Voice brain"
              footnote="Auto follows the runtime you picked for the orchestrator. A runtime you pick here whose CLI isn't installed falls through to one that is, and the line above says which."
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
                divider
              />
              <SettingsRow
                icon={<BrainGlyph />}
                label="Symon brain"
                subtitle={
                  <>
                    Which installed agent CLI runs the background brain.
                    <span
                      style={{
                        display: 'block',
                        marginTop: 4,
                        color: brainStatusTone,
                      }}
                    >
                      {brainStatus}
                    </span>
                  </>
                }
                accessory={
                  <SettingsSegmented
                    value={brain?.provider ?? 'auto'}
                    onChange={handleBrainProvider}
                    options={brainProviderOptions}
                  />
                }
                divider
              />
              <SettingsRow
                icon={<BrainGlyph />}
                label="Seat"
                subtitle="Worker is the cheap everyday rung; Builder runs the stronger model at full reasoning."
                accessory={
                  <SettingsSegmented
                    value={brain?.tier ?? 'auto'}
                    onChange={handleBrainTier}
                    options={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'worker', label: 'Worker' },
                      { value: 'builder', label: 'Builder' },
                    ]}
                  />
                }
                divider
              />
              <SettingsRow
                icon={<BrainGlyph />}
                label="Model pin"
                subtitle="Optional. Overrides the seat above — leave empty to let the runtime choose."
                accessory={
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={brainModelInput}
                      onChange={(e) => setBrainModelInput(e.target.value)}
                      placeholder={brainModelPlaceholder}
                      spellCheck={false}
                      style={{
                        width: 210,
                        height: 26,
                        paddingLeft: 9,
                        paddingRight: 9,
                        fontSize: 12,
                        fontWeight: 300,
                        fontFamily: APP_FONT_STACK,
                        color: 'var(--t-text)',
                        background: 'var(--t-input-bg)',
                        border: '1px solid var(--t-divider)',
                        borderRadius: 7,
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => { void handleBrainModel(); }}
                      disabled={brainModelInput.trim() === (brain?.model ?? '')}
                      style={{
                        height: 26,
                        paddingLeft: 10,
                        paddingRight: 10,
                        fontSize: 12,
                        fontWeight: 300,
                        letterSpacing: '-0.1px',
                        fontFamily: APP_FONT_STACK,
                        color: 'var(--t-text)',
                        background: 'var(--t-input-bg)',
                        border: '1px solid var(--t-divider)',
                        borderRadius: 7,
                        cursor: brainModelInput.trim() === (brain?.model ?? '') ? 'default' : 'pointer',
                      }}
                    >
                      {brainModelInput.trim() ? 'Save' : 'Clear'}
                    </button>
                  </span>
                }
              />
            </SettingsGroup>
          </section>

          <SymonAttentionSettingsSection />

          <section style={{ marginTop: 28 }}>
            <SettingsGroup>
              <SettingsRow
                icon={<SparkleIcon />}
                label="Symon settings"
                subtitle="History, polish, dictionary, voice persona — double-tap Symon, or open here"
                onPress={() => { void openVoiceSettings(); }}
                chevron
              />
            </SettingsGroup>
          </section>
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
        <span style={{ color: RAMS_ACCENT }}>{externalFn?.active ? 'LEFT CTRL / FN' : 'FN'}</span> &nbsp; Dictate &nbsp;·&nbsp; <span style={{ color: RAMS_ACCENT }}>RIGHT OPTION</span> &nbsp; Talk to Symon
      </p>
    </div>
  );
}
