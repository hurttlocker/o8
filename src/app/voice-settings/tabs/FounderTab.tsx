'use client';

/**
 * Founder tab — Symon's voice engine + a personal Voice Library. Tune an
 * ElevenLabs voice below, then save it by name into the library and recall it
 * anytime. o8 already reads the elevenlabs_* prefs (tts/elevenlabs.rs); the
 * library is a list of named presets persisted as `voice_library`. All via
 * voice_prefs_set + round-trip through voice_prefs_get.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import {
  ACCENT, ACCENT_GLOW, ACCENT_LIGHT, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, OK_GREEN, SF,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TRANS_FAST, ICONS, SECTION_BORDER,
} from '../tokens';
import {
  SectionCard, SectionTitle, SectionHint, ControlRow, ToggleRow, Select, Slider, AccentButton, GhostButton, Icon, PageHeader,
} from '../primitives';
import { prefBool, prefStr, prefNum, prefVoiceLibrary, type VoicePreset, type TabProps } from '../helpers';
import { ttsSpeak, ttsStop } from '@/lib/tauri/bridge';

const INPUT_BASE: CSSProperties = {
  width: 220, boxSizing: 'border-box', height: 32, paddingLeft: 10, paddingRight: 10,
  background: GLASS_BG, border: `1px solid ${GLASS_BORDER_SUBTLE}`, borderRadius: 8,
  color: TEXT_PRIMARY, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  outline: 'none', transition: `border-color ${TRANS_FAST}, box-shadow ${TRANS_FAST}`,
};
const focusRing = (f: boolean): CSSProperties =>
  f ? { borderColor: ACCENT, boxShadow: `0 0 0 2px ${ACCENT_GLOW}`, background: GLASS_BG_HOVER } : {};

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
  const [newName, setNewName] = useState('');
  const [nameFocus, setNameFocus] = useState(false);

  const provider = prefStr(prefs, 'tts_provider', 'elevenlabs');
  const voiceId = prefStr(prefs, 'elevenlabs_voice_id', '');
  const modelId = prefStr(prefs, 'elevenlabs_model_id', 'eleven_turbo_v2_5');
  const stability = prefNum(prefs, 'elevenlabs_stability', 0.5);
  const similarity = prefNum(prefs, 'elevenlabs_similarity_boost', 0.75);
  const style = prefNum(prefs, 'elevenlabs_style', 0.0);
  const speakerBoost = prefBool(prefs, 'elevenlabs_use_speaker_boost', true);

  const library = prefVoiceLibrary(prefs, 'voice_library');

  const saveCurrent = () => {
    const name = newName.trim();
    if (!name) return;
    const preset: VoicePreset = {
      id: `v${Date.now()}`, name, provider, voiceId, modelId, stability, similarity, style, speakerBoost,
    };
    // Replace a same-named preset rather than duplicate.
    const next = [...library.filter((p) => p.name.toLowerCase() !== name.toLowerCase()), preset];
    setPref('voice_library', next);
    setNewName('');
  };
  // Not a hook — the `use` prefix tripped react-hooks/rules-of-hooks.
  const applyPreset = (p: VoicePreset) => {
    setPref('tts_provider', p.provider);
    setPref('elevenlabs_voice_id', p.voiceId);
    setPref('elevenlabs_model_id', p.modelId);
    setPref('elevenlabs_stability', p.stability);
    setPref('elevenlabs_similarity_boost', p.similarity);
    setPref('elevenlabs_style', p.style);
    setPref('elevenlabs_use_speaker_boost', p.speakerBoost);
  };
  const deletePreset = (id: string) => setPref('voice_library', library.filter((p) => p.id !== id));

  const onPreview = async () => {
    setPreviewing(true);
    await ttsSpeak('This is my ElevenLabs voice — tuned the way I like it.');
    setTimeout(() => setPreviewing(false), 2800);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.crown} title="Founder" />

      {/* Voice library */}
      <SectionCard>
        <SectionTitle icon={ICONS.crown}>Voice library</SectionTitle>
        <SectionHint>Save the voices you like by name, then recall any one with a click. Saves your current voice config below.</SectionHint>
        {library.length === 0 ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY, marginBottom: 12 }}>No saved voices yet — tune one below and save it.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {library.map((p) => (
              <VoiceCard
                key={p.id} preset={p} active={p.voiceId === voiceId && p.provider === provider}
                onUse={() => applyPreset(p)} onDelete={() => deletePreset(p.id)}
              />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } }}
            onFocus={() => setNameFocus(true)} onBlur={() => setNameFocus(false)}
            placeholder="Name this voice"
            style={{ ...INPUT_BASE, flex: 1, fontFamily: SF, ...focusRing(nameFocus) }}
          />
          <AccentButton label="Save current" onClick={saveCurrent} />
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.speakerHigh}>Engine</SectionTitle>
        <ControlRow label="TTS provider" detail="Which engine reads answers and selected text aloud.">
          <Select value={provider} onChange={(v) => setPref('tts_provider', v)} options={PROVIDER_OPTS} width={200} />
        </ControlRow>
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.sparkle}>ElevenLabs voice</SectionTitle>
        <SectionHint>Tune the voice, then save it to your library above. The API key is set via env or dictation.json and never shown here.</SectionHint>
        <ControlRow label="Voice ID" detail="The ElevenLabs voice to speak with.">
          <input
            value={voiceId} onChange={(e) => setPref('elevenlabs_voice_id', e.target.value)}
            onFocus={() => setVoiceFocus(true)} onBlur={() => setVoiceFocus(false)}
            placeholder="voice id" style={{ ...INPUT_BASE, ...focusRing(voiceFocus) }}
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

      <RealtimeSection />
    </div>
  );
}

/**
 * Realtime voice (Symon S2S, beta) — Track B P2. Bring your own OpenAI key
 * (free; bills OpenAI directly) and Test that it mints a gpt-realtime session.
 * The live conversation loop ships next (P3); the always-on toggle lands with
 * it so there's no control that does nothing here. Managed (proxied, paid) is
 * the entitlement lever and surfaces when wired.
 */
function RealtimeSection() {
  const [masked, setMasked] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyFocus, setKeyFocus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/keys', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { providers?: Array<{ id: string; configured: boolean; maskedKey: string | null }> } | null) => {
        if (cancelled || !d?.providers) return;
        const openai = d.providers.find((p) => p.id === 'openai');
        if (openai?.configured) setMasked(openai.maskedKey);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch('/api/v2/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider: 'openai', key }),
      });
      const d = await r.json().catch(() => null) as { maskedKey?: string; error?: string } | null;
      if (r.ok && d?.maskedKey) {
        setMasked(d.maskedKey);
        setKeyInput('');
        setSaveMsg({ ok: true, text: 'Saved — encrypted at rest.' });
      } else {
        setSaveMsg({ ok: false, text: d?.error || `Couldn't save (${r.status}).` });
      }
    } catch {
      setSaveMsg({ ok: false, text: 'Save failed — is the app running?' });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (testing) return;
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await fetch('/api/voice/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => null) as { ok?: boolean; model?: string; reason?: string } | null;
      if (r.ok && d?.ok) {
        setTestMsg({ ok: true, text: `Connected — minted a ${d.model || 'realtime'} session.` });
      } else {
        setTestMsg({ ok: false, text: d?.reason || `Realtime not ready (${r.status}).` });
      }
    } catch {
      setTestMsg({ ok: false, text: 'Test failed — is the app running?' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SectionCard>
      <SectionTitle icon={ICONS.sparkle}>Realtime voice · beta</SectionTitle>
      <SectionHint>
        Voice-to-voice with gpt-realtime. Bring your own OpenAI key and it&apos;s free — you pay OpenAI directly. (Managed, metered realtime is the paid path and arrives later.) The live conversation loop ships next; this is where you wire the key.
      </SectionHint>
      <ControlRow label="OpenAI API key" detail={masked ? `Saved: ${masked}. Enter a new key to replace it.` : 'Bring your own key — encrypted at rest, billed to you.'}>
        <input
          type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveKey(); } }}
          onFocus={() => setKeyFocus(true)} onBlur={() => setKeyFocus(false)}
          placeholder={masked ? '•••• replace' : 'sk-...'}
          style={{ ...INPUT_BASE, ...focusRing(keyFocus) }}
        />
      </ControlRow>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <AccentButton label={saving ? 'Saving…' : 'Save key'} onClick={() => { void saveKey(); }} />
        <GhostButton label={testing ? 'Testing…' : 'Test connection'} onClick={() => { void testConnection(); }} />
      </div>
      {saveMsg ? (
        <p style={{ fontSize: 12, color: saveMsg.ok ? OK_GREEN : '#f08a8a', marginTop: 10, marginBottom: 0 }}>{saveMsg.text}</p>
      ) : null}
      {testMsg ? (
        <p style={{ fontSize: 12, color: testMsg.ok ? OK_GREEN : '#f08a8a', marginTop: 8, marginBottom: 0 }}>{testMsg.text}</p>
      ) : null}
    </SectionCard>
  );
}

function VoiceCard({ preset, active, onUse, onDelete }: { preset: VoicePreset; active: boolean; onUse: () => void; onDelete: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12,
        border: `1px solid ${active ? 'rgba(64,88,255,0.40)' : SECTION_BORDER}`,
        background: active ? 'rgba(64,88,255,0.12)' : GLASS_BG,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 400, color: TEXT_PRIMARY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preset.name}</div>
        <div style={{ fontSize: 11, color: TEXT_TERTIARY, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preset.provider} · {preset.voiceId || 'no id'}
        </div>
      </div>
      {active ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: OK_GREEN }}>
          <Icon icon={ICONS.check} size={13} /> Active
        </span>
      ) : (
        <button
          type="button" onClick={onUse}
          style={{
            height: 26, paddingLeft: 12, paddingRight: 12, borderRadius: 8, cursor: 'pointer',
            border: '1px solid rgba(90,132,255,0.30)', background: hover ? 'rgba(90,132,255,0.22)' : 'rgba(90,132,255,0.14)',
            color: ACCENT_LIGHT, fontSize: 11.5, fontFamily: SF,
          }}
        >Use</button>
      )}
      <button
        type="button" aria-label={`Delete ${preset.name}`} onClick={onDelete}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 7,
          border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: 'transparent', color: TEXT_TERTIARY, cursor: 'pointer', padding: 0,
        }}
      >
        <Icon icon={ICONS.close} size={12} />
      </button>
    </div>
  );
}
