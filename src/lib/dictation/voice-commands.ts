/**
 * Deterministic voice-command processor for dictation.
 *
 * Symon ships a Rust-side processor that catches "cancel", "scratch
 * that", "remove that", etc. BEFORE polish — saves an LLM round-trip
 * on the most common cancellation phrases. Ported as TS so we can run
 * it on the raw transcript before hitting the polish API.
 */

export type VoiceCommandResult =
  | { kind: 'cancel'; reason: string }
  | { kind: 'text'; text: string };

const CANCEL_PHRASES = [
  /^\s*cancel\.?\s*$/i,
  /^\s*never ?mind\.?\s*$/i,
  /^\s*scratch that\.?\s*$/i,
  /^\s*forget (that|it)\.?\s*$/i,
];

const TRAILING_REMOVE_PHRASES = [
  /\b(?:remove|delete|undo)(?:\s+that)?\.?\s*$/i,
];

const NEW_LINE_PHRASES = [
  /\bnew(?:\s+|-)?line\b/gi,
  /\bnext(?:\s+|-)?line\b/gi,
];

export function processVoiceCommands(rawTranscript: string): VoiceCommandResult {
  const trimmed = rawTranscript.trim();
  if (!trimmed) {
    return { kind: 'cancel', reason: 'Empty transcript' };
  }

  // Whole-utterance cancels: bail before polish.
  for (const pattern of CANCEL_PHRASES) {
    if (pattern.test(trimmed)) {
      return { kind: 'cancel', reason: 'User cancelled by voice.' };
    }
  }

  // Strip trailing "remove that" / "undo" — drop the command phrase plus
  // the previous word. Symon's behavior. The polish pass cleans up the
  // resulting fragment.
  let working = trimmed;
  let stripped = false;
  for (const pattern of TRAILING_REMOVE_PHRASES) {
    if (pattern.test(working)) {
      working = working.replace(pattern, '').trimEnd();
      // Drop the previous word as the "that" target.
      working = working.replace(/\s*\S+\s*$/u, '').trim();
      stripped = true;
      break;
    }
  }

  if (stripped && working.length === 0) {
    return { kind: 'cancel', reason: 'Removed all content via undo.' };
  }

  // "new line" / "next line" → literal newline, both inline and as
  // standalone words. Apply repeatedly.
  for (const pattern of NEW_LINE_PHRASES) {
    working = working.replace(pattern, '\n');
  }
  // Collapse runs of spaces around the inserted newlines.
  working = working.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();

  return { kind: 'text', text: working };
}
