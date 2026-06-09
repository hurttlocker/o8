'use client';

/**
 * Founder tab — ElevenLabs personal-voice config (Symon's Founder page). o8
 * already has the elevenlabs_* prefs (tts/elevenlabs.rs reads them); this is
 * their first UI surface. All persist via voice_prefs_set + round-trip through
 * voice_prefs_get. The API key itself is set via env / dictation.json (never
 * shown here — config_public strips it).
 */
import { useState, type CSSProperties } from 'react';
import {
  ACCENT, ACCENT_GLOW, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, SF, TEXT_PRIMARY, TEXT_TERTIARY, TRANS_FAST, ICONS,
} from '../tokens';
import {
  SectionCard, SectionTitle, SectionHint, ControlRow, ToggleRow, Select, Slider, AccentButton, GhostButton, PAGE_TITLE_STYLE,
} from '../primitives';
import { prefBool, prefStr, prefNum, type TabProps } from '../helpers';
import { ttsSpeak, ttsStop } from '@/lib/tauri/bridge';

const INPUT_BASE: CSSProperties = {
  width: 220, boxSizing: 'border-box', height: 32, paddingLeft: 10, paddingRight: 10,
  background: GLASS_BG, border: `1px solid ${GLASS_BORDER_SUBTLE}`, borderRadius: 8,
  color: TEXT_PRIMARY, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  outline: 'none', transition: `border-color ${TRANS_FAST}, box-shadow ${TRANS_FAST}`,
};

const PROVIDER_OPTS = [
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'google', label: 'Google Cloud' },
  { value: 'say', label: 'System (macOS)' },
];
const MODEL_OPTS = [
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5 (fast)' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
  { value: 'eleven_monolingual_v1', label: 'Monolingual v1' },
];

export default function FounderTab({ prefs, setPref }: TabProps) {
  const [voiceFocus, setVoiceFocus] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const provider = prefStr(prefs, 'tts_provider', 'elevenlabs');
  const voiceId = prefStr(prefs, 'elevenlabs_voice_id', '');
  const modelId = prefStr(prefs, 'elevenlabs_model_id', 'eleven_turbo_v2_5');
  const stability = prefNum(prefs, 'elevenlabs_stability', 0.5);
  const similarity = prefNum(prefs, 'elevenlabs_similarity_boost', 0.75);
  const style = prefNum(prefs, 'elevenlabs_style', 0.0);
  const speakerBoost = prefBool(prefs, 'elevenlabs_use_speaker_boost', true);

  const onPreview = async () => {
    setPreviewing(true);
    await ttsSpeak('This is my ElevenLabs voice — tuned the way I like it.');
    setTimeout(() => setPreviewing(false), 2800);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={PAGE_TITLE_STYLE}>Founder</h1>

      <SectionCard>
        <SectionTitle icon={ICONS.speakerHigh}>Engine</SectionTitle>
        <ControlRow label="TTS provider" detail="Which engine reads answers and selected text aloud.">
          <Select value={provider} onChange={(v) => setPref('tts_provider', v)} options={PROVIDER_OPTS} width={200} />
        </ControlRow>
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.crown}>ElevenLabs voice</SectionTitle>
        <SectionHint>Your personal voice. The API key is set via env or dictation.json and never shown here.</SectionHint>
        <ControlRow label="Voice ID" detail="The ElevenLabs voice to speak with.">
          <input
            value={voiceId} onChange={(e) => setPref('elevenlabs_voice_id', e.target.value)}
            onFocus={() => setVoiceFocus(true)} onBlur={() => setVoiceFocus(false)}
            placeholder="voice id"
            style={{ ...INPUT_BASE, ...(voiceFocus ? { borderColor: ACCENT, boxShadow: `0 0 0 2px ${ACCENT_GLOW}`, background: GLASS_BG_HOVER } : {}) }}
          />
        </ControlRow>
        <ControlRow label="Model" detail="Quality vs latency.">
          <Select value={modelId} onChange={(v) => setPref('elevenlabs_model_id', v)} options={MODEL_OPTS} width={200} />
        </ControlRow>
        <ControlRow label="Stability" detail="Lower = more expressive, higher = more consistent.">
          <Slider value={stability} min={0} max={1} step={0.05} onChange={(v) => setPref('elevenlabs_stability', v)} />
        </ControlRow>
        <ControlRow label="Similarity" detail="How closely to match the source voice.">
          <Slider value={similarity} min={0} max={1} step={0.05} onChange={(v) => setPref('elevenlabs_similarity_boost', v)} />
        </ControlRow>
        <ControlRow label="Style" detail="Style exaggeration (0 keeps it neutral).">
          <Slider value={style} min={0} max={1} step={0.05} onChange={(v) => setPref('elevenlabs_style', v)} />
        </ControlRow>
        <ToggleRow
          label="Speaker boost"
          detail="Sharpens similarity to the source voice at a small latency cost."
          checked={speakerBoost} onChange={(v) => setPref('elevenlabs_use_speaker_boost', v)}
        />
        <div style={{ marginTop: 14 }}>
          {previewing
            ? <GhostButton label="Stop" tone="danger" onClick={() => { void ttsStop(); setPreviewing(false); }} />
            : <AccentButton label="Preview voice" onClick={() => { void onPreview(); }} />}
        </div>
      </SectionCard>
    </div>
  );
}
