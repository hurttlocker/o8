/**
 * compactPacketLabel — turn a conventional-commit packet title into a
 * scannable 3-word tab label.
 *
 *   feat(orchestrator): slash commands — /compact /clear /focus   →  Slash commands
 *   feat(orchestrator): auto-thread-rotation when packets merge   →  Auto thread rotation
 *   design(orchestrator): redesign Edit File cards in Rams style  →  Redesign edit file
 *
 * Rules:
 *   1. Strip conventional-commit prefix: `feat(...):`, `fix:`, `design(scope):`, etc.
 *   2. Split on whitespace AND hyphens — `auto-thread-rotation` becomes 3 words.
 *   3. Drop pure-punctuation tokens like `—`, `/`, `+`, `·`.
 *   4. Keep at most `maxWords` (default 3) meaningful words.
 *   5. Sentence case: first letter upper, rest lower. Acronyms are not preserved
 *      since packet titles are human-authored prose, not code identifiers.
 */

const CONVENTIONAL_PREFIX = /^[a-z][a-z0-9_-]*(?:\([^)]*\))?\s*:\s*/i;
const CLAUSE_SEPARATORS = /[–—/+·|]/;
const LEADING_TRAILING_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const PUNCT_ONLY = /^[^\p{L}\p{N}]+$/u;

function sentenceCase(value: string): string {
  if (!value) return value;
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function compactPacketLabel(title: string | null | undefined, maxWords = 3): string {
  const raw = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  const withoutPrefix = raw.replace(CONVENTIONAL_PREFIX, '').trim();
  const source = withoutPrefix || raw;

  // Truncate at the first clause separator — em-dash, slash, plus, pipe.
  // Packet titles often stuff details after these; the first clause is the
  // scannable "what" and everything after is elaboration.
  const firstClause = source.split(CLAUSE_SEPARATORS)[0]?.trim() || source;

  const words = firstClause
    .replace(/-/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(LEADING_TRAILING_PUNCT, ''))
    .filter((word) => word.length > 0 && !PUNCT_ONLY.test(word))
    .slice(0, maxWords);

  if (words.length === 0) return sentenceCase(firstClause);
  return sentenceCase(words.join(' '));
}
