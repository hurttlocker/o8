/**
 * Deterministic agent codenames — voice/canvas multi-agent identity (Triton-style,
 * 2026-06-20). A spawned agent gets a memorable, phonetically-distinct name so the
 * operator can SEE which card is which while a fleet works, and (next slice) ADDRESS
 * it by voice — "Atlas, run the tests". Pure + deterministic on the lane id, so the
 * same lane yields the same name on the client (card label) and the server (voice
 * "Atlas" → recompute codename(laneId) across active lanes → the lane it names).
 */

// Curated for the ear: short, common, phonetically distinct (no rhyming pairs),
// reliably transcribed by speech-to-text. Order is irrelevant — the hash picks.
const POOL = [
  'Atlas', 'Nova', 'Comet', 'Sage', 'Echo', 'Iris',
  'Bolt', 'Onyx', 'Halo', 'Pike', 'Flint', 'Maple',
  'Grove', 'Dune', 'Vault', 'Lumen', 'Cosmo', 'Jet',
  'Rocky', 'Skye', 'Bubble', 'Marshall', 'Zephyr', 'Koda',
] as const;

/** A stable, voice-friendly name for a seed (the lane id). Pure + deterministic. */
export function codename(seed: string): string {
  // djb2 — tiny, stable, good spread for short keys.
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return POOL[h % POOL.length];
}

/** The full name pool — voice resolution scans active lanes (not this list), but
 *  exposing it lets a recognizer bias toward known names. */
export function codenamePool(): readonly string[] {
  return POOL;
}

/** Identity color per worker runtime — mirrors `accentColor` in
 *  runtime-capabilities.ts (the canonical source). These are brand accents, not
 *  theme surfaces, so raw hex is correct here (the theme-token rule is about
 *  surface backgrounds). Unknown runtime falls back to the muted canvas ink. */
export function runtimeColor(runtime: string | null | undefined): string {
  switch (runtime) {
    case 'codex': return '#2563eb'; // blue
    case 'claude-code': return '#e07a3a'; // orange
    case 'gemini': return '#4285f4'; // Google blue
    case 'opencode': return '#a855f7'; // purple
    case 'cursor': return '#111827'; // near-black
    case 'grok': return '#16a34a'; // green
    default: return 'var(--cnv-ink-muted)';
  }
}
