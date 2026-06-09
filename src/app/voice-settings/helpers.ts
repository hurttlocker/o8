/**
 * Voice-settings shared helpers — typed accessors over the raw prefs object
 * (`voice_prefs_get`) + the option lists for the Settings selects. Booleans round
 * back as real booleans here (Rust serde), unlike Symon's `'true'`/`'false'`
 * strings, so accessors stay simple.
 */

export type Prefs = Record<string, unknown>;
export type SetPref = (key: string, value: unknown) => void;

export interface TabProps {
  prefs: Prefs;
  setPref: SetPref;
}

export function prefBool(p: Prefs, key: string, def: boolean): boolean {
  const v = p[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return def;
}

export function prefStr(p: Prefs, key: string, def = ''): string {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : def;
}

export function prefNum(p: Prefs, key: string, def: number): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = parseFloat(v); if (Number.isFinite(n)) return n; }
  return def;
}

export function prefList(p: Prefs, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export interface ReplacementRule { trigger: string; replacement: string }

export function prefReplacements(p: Prefs, key: string): ReplacementRule[] {
  const v = p[key];
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (x && typeof x === 'object' && 'trigger' in x && 'replacement' in x) {
      const t = (x as Record<string, unknown>).trigger;
      const r = (x as Record<string, unknown>).replacement;
      if (typeof t === 'string' && typeof r === 'string') return [{ trigger: t, replacement: r }];
    }
    return [];
  });
}

// ── Option lists ──
export const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'ja-JP', label: 'Japanese' },
];

// How aggressively o8 cleans up the final transcript (persisted as `output_tone`;
// applied in the polish prompt — Rust wiring batched separately).
export const TONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'raw', label: 'Raw' },
  { value: 'clean', label: 'Clean' },
  { value: 'formal', label: 'Formal' },
  { value: 'casual', label: 'Casual' },
];

// Read-aloud / Ask voices. Cloud TTS (Google/ElevenLabs) honors the id; the macOS
// `say` fallback ignores it. Persisted as `tts_voice_id`.
export const VOICE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en-US-Neural2-J', label: 'Google · Male (J)' },
  { value: 'en-US-Neural2-D', label: 'Google · Male (D)' },
  { value: 'en-US-Neural2-F', label: 'Google · Female (F)' },
  { value: 'en-US-Neural2-H', label: 'Google · Female (H)' },
  { value: 'en-US-Wavenet-I', label: 'Google · Wavenet Male' },
  { value: 'en-US-Wavenet-H', label: 'Google · Wavenet Female' },
];

export const PREVIEW_LINE = 'Hi — this is how I sound reading your text aloud.';
