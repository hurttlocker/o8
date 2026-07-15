'use client';

/**
 * Settings tab — the main page. Section cards: Input, Voice Output, Audio
 * Feedback, Permissions. Every control persists via `voice_prefs_set`
 * (round-trips through `voice_prefs_get`); locale also applies live, preview
 * speaks through the current voice. Backend-gated rows (mic enumeration, tone /
 * replacement apply) degrade gracefully until the Rust batch ships.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  sttSetLocale, ttsSpeak, ttsStop, sttListInputDevices, sttSetInputDevice,
  accessibilityPermissionGranted, inputMonitoringGranted, fnKeyUsageType, openSystemSettings,
  screenCaptureGranted, micPermissionGranted,
  type InputDevice,
} from '@/lib/tauri/bridge';
import {
  ICONS, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, GLASS_BORDER_SUBTLE, DANGER_RED,
} from '../tokens';
import {
  SectionCard, SectionTitle, SectionHint, ToggleRow, ControlRow, Select, Segmented, Slider,
  StatusBadge, GhostButton, AccentButton, PageHeader,
} from '../primitives';
import {
  prefBool, prefStr, prefNum, LOCALE_OPTIONS, TONE_OPTIONS, VOICE_OPTIONS, PREVIEW_LINE,
  type TabProps,
} from '../helpers';

const URL_ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const URL_INPUT_MONITORING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
const URL_KEYBOARD = 'x-apple.systempreferences:com.apple.preference.keyboard';
const URL_MICROPHONE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const URL_SCREEN_RECORDING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export default function SettingsTab({ prefs, setPref }: TabProps) {
  const [devices, setDevices] = useState<InputDevice[] | null>(null);
  const [acc, setAcc] = useState<boolean | null>(null);
  const [input, setInput] = useState<boolean | null>(null);
  const [fn, setFn] = useState<number | null | undefined>(undefined);
  const [mic, setMic] = useState<boolean | null>(null);
  const [screen, setScreen] = useState<boolean | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const loadPerms = useCallback(async () => {
    const [a, i, f, m, s] = await Promise.all([
      accessibilityPermissionGranted(), inputMonitoringGranted(), fnKeyUsageType(),
      micPermissionGranted(), screenCaptureGranted(),
    ]);
    setAcc(a); setInput(i); setFn(f); setMic(m); setScreen(s);
  }, []);

  useEffect(() => {
    void sttListInputDevices().then(setDevices);
    void loadPerms();
  }, [loadPerms]);

  useEffect(() => {
    const onFocus = () => { void loadPerms(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadPerms]);

  // ── Input ──
  const micValue = prefStr(prefs, 'dictation_microphone_uid', 'default');
  const micOptions = devices && devices.length
    ? [
        { value: 'default', label: 'System Default' },
        ...devices.map((d) => ({ value: d.id, label: d.is_default ? `${d.name} (default)` : d.name })),
      ]
    : [{ value: 'default', label: 'System Default' }];
  const locale = prefStr(prefs, 'dictation_locale', 'en-US');
  const tone = prefStr(prefs, 'output_tone', 'auto');
  const highAccuracy = prefBool(prefs, 'whisper_stt_enabled', true);
  const partialsSurface = prefStr(prefs, 'dictation_partials_surface', 'caret');

  // ── Voice Output ──
  const voiceId = prefStr(prefs, 'tts_voice_id', 'en-US-Neural2-J');
  const readingSpeed = prefNum(prefs, 'reading_speed', 1.0);

  // ── Feedback ──
  const ducking = prefBool(prefs, 'ducking_enabled', true);
  const sounds = prefBool(prefs, 'sounds_enabled', true);

  const onLocale = (v: string) => { setPref('dictation_locale', v); void sttSetLocale(v); };
  const onMic = (v: string) => { setPref('dictation_microphone_uid', v); if (v !== 'default') void sttSetInputDevice(v); };
  const onPreview = async () => {
    setPreviewing(true);
    await ttsSpeak(PREVIEW_LINE);
    setTimeout(() => setPreviewing(false), 2600);
  };

  // AppleFnUsageType: 0 = Do Nothing (free for o8). On macOS 26+ the key ships
  // UNSET (null) yet Fn is still free — only an explicit 1/2/3 (input-source /
  // emoji / Start-Dictation) actually hijacks it. Treat unset as OK so we don't
  // false-alarm machines where Fn dictation already works.
  const fnHijacked = typeof fn === 'number' && fn !== 0;
  const fnGranted = fn !== undefined && !fnHijacked;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.gear} title="Settings" />

      {/* Input */}
      <SectionCard>
        <SectionTitle icon={ICONS.microphone}>Input</SectionTitle>
        <ControlRow label="Microphone" detail="Which connected mic o8 listens to. System Default follows macOS.">
          <Select value={micValue} onChange={onMic} options={micOptions} width={200} />
        </ControlRow>
        <ToggleRow
          label="High-accuracy dictation"
          detail="Keeps live words instant, then cleans the final text with Whisper. Falls back automatically if unavailable."
          checked={highAccuracy} onChange={(v) => setPref('whisper_stt_enabled', v)}
        />
        <ControlRow
          label="Live dictation"
          stacked
          detail="At caret streams provisional words only into verified editable fields. Screen keeps the original bottom transcript bar."
        >
          <Segmented
            value={partialsSurface}
            onChange={(v) => setPref('dictation_partials_surface', v)}
            options={[
              { value: 'caret', label: 'At caret' },
              { value: 'hud', label: 'Screen bar' },
              { value: 'off', label: 'Off' },
            ]}
            full
          />
        </ControlRow>
        <ControlRow label="Dictation language" detail="Language the recognizer expects.">
          <Select value={locale} onChange={onLocale} options={LOCALE_OPTIONS} width={200} />
        </ControlRow>
        <ControlRow
          label="Tone" stacked
          detail="How much o8 cleans up your wording after dictation."
        >
          <Segmented value={tone} onChange={(v) => setPref('output_tone', v)} options={TONE_OPTIONS} full />
        </ControlRow>
      </SectionCard>

      {/* Voice Output */}
      <SectionCard>
        <SectionTitle icon={ICONS.speakerHigh}>Voice Output</SectionTitle>
        <SectionHint>How o8 reads answers and selected text aloud.</SectionHint>
        <ControlRow label="Read-aloud voice" detail="Used for Ask answers and read-aloud. Cloud voices honor this; the system fallback uses the default voice.">
          <Select value={voiceId} onChange={(v) => setPref('tts_voice_id', v)} options={VOICE_OPTIONS} width={200} />
        </ControlRow>
        <ControlRow label="Preview voice" detail="Speaks a short sample with the selected voice + speed.">
          {previewing
            ? <GhostButton label="Stop" tone="danger" onClick={() => { void ttsStop(); setPreviewing(false); }} />
            : <AccentButton label="Preview" onClick={() => { void onPreview(); }} />}
        </ControlRow>
        <ControlRow label="Speaking speed" detail="How fast Symon talks — pitch stays natural. Also adjustable from the dock while he speaks.">
          <Slider value={readingSpeed} min={0.7} max={1.2} step={0.05} suffix="×" onChange={(v) => setPref('reading_speed', v)} />
        </ControlRow>
      </SectionCard>

      {/* Audio Feedback */}
      <SectionCard>
        <SectionTitle icon={ICONS.speakerHigh}>Audio Feedback</SectionTitle>
        <ToggleRow
          label="Dim other audio while dictating"
          detail="Lower system volume to 20% while you hold Fn, so the mic hears you over whatever's playing — including o8's own voice."
          checked={ducking} onChange={(v) => setPref('ducking_enabled', v)}
        />
        <ToggleRow
          label="Sound cues"
          detail="Short tones for listen start/stop, paste landed, and read-aloud."
          checked={sounds} onChange={(v) => setPref('sounds_enabled', v)}
        />
      </SectionCard>

      {/* Permissions */}
      <SectionCard>
        <SectionTitle
          icon={ICONS.eye}
          status={acc && input && fnGranted && mic !== false && screen ? 'All granted' : undefined}
          right={<GhostButton label="Re-check" onClick={() => { void loadPerms(); }} />}
        >Permissions</SectionTitle>
        <SectionHint>Voice and Symon&rsquo;s screen sight need these macOS grants. If a row shows granted but the feature still fails, toggle the grant off and on in System Settings, then relaunch o8.</SectionHint>
        <PermRow label="Microphone" granted={mic} onOpen={() => { void openSystemSettings(URL_MICROPHONE); }} />
        <PermRow label="Accessibility" granted={acc} onOpen={() => { void openSystemSettings(URL_ACCESSIBILITY); }} />
        <PermRow label="Input Monitoring" granted={input} onOpen={() => { void openSystemSettings(URL_INPUT_MONITORING); }} />
        <PermRow label="Screen Recording" granted={screen} onOpen={() => { void openSystemSettings(URL_SCREEN_RECORDING); }} />
        <PermRow label="Fn key binding" granted={fn === undefined ? null : fnGranted} onOpen={() => { void openSystemSettings(URL_KEYBOARD); }} />
        {fnHijacked ? (
          <div style={{
            marginTop: 12,
            paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12,
            borderRadius: 12,
            border: `1px solid rgba(248,113,113,0.3)`, background: 'rgba(248,113,113,0.08)',
            fontSize: 12, lineHeight: 1.5, color: TEXT_SECONDARY,
          }}>
            <strong style={{ color: DANGER_RED, fontWeight: 500 }}>The Fn key is hijacked.</strong>{' '}
            macOS starts Apple Dictation on Fn. Open Keyboard Settings → set the Globe-key action (&ldquo;Press Globe key to&rdquo;) → &ldquo;Do Nothing&rdquo;.
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

function PermRow({ label, granted, onOpen }: { label: string; granted: boolean | null; onOpen: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 11, paddingBottom: 11, borderBottom: `1px solid ${GLASS_BORDER_SUBTLE}` }}>
      <span style={{ fontSize: 13, color: TEXT_PRIMARY, flex: 1 }}>{label}</span>
      {granted === null ? <span style={{ fontSize: 12, color: TEXT_TERTIARY }}>—</span> : <StatusBadge ok={granted} />}
      <GhostButton label="Open" onClick={onOpen} />
    </div>
  );
}
