import 'server-only';

export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'were', 'will', 'with', 'what', 'which', 'who', 'why',
  'when', 'where', 'do', 'does', 'did', 'i', 'you', 'we', 'they', 'them',
  'their', 'our', 'us', 'me', 'should', 'would', 'could', 'can', 'may',
  'might', 'must', 'shall', 'about', 'into', 'over', 'than', 'then',
]);

export function tokenizeForGrep(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

const SYNTHESIS_VETO = /\b(why|how|should|when did|who (owns|decided|approved)|what (happened|changed|decided)|incident|outage|regression|decision|rationale|tradeoff|process|workflow|own(s|er|ership)|explain|compare|difference between|over time|history|coincidence|equivalent)\b/i;
const EXPLICIT_VALUE_ASK = /\b(value|values|default|string value|current value)\s+(of|for)\b/i;
const SCREAMING_SNAKE_CASE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const LITERAL_ARTIFACT_NOUN = /\b(port range|socket path|path template|api paths|constant|constants)\b/i;

export function detectLiteralLookup(question: string): boolean {
  if (SYNTHESIS_VETO.test(question)) return false;
  return (
    EXPLICIT_VALUE_ASK.test(question) ||
    SCREAMING_SNAKE_CASE.test(question) ||
    LITERAL_ARTIFACT_NOUN.test(question)
  );
}
