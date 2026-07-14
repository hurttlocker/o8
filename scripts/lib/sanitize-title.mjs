/**
 * Sanitize a report title before it goes PUBLIC.
 *
 * THE LEAK THIS CLOSES: the report's private half (screenshot, crash traces, repo
 * paths) never leaves the private intake channel. But the reporter's own PROSE was
 * being republished verbatim — into #fixed, and into fixed.json, which is a
 * WORLD-READABLE GitHub release asset. No Discord role, no login, just a URL.
 *
 * So "the diff panel breaks when I open /Users/bob/clients/acme-secret-merger"
 * became a permanent public fact about Bob's employer. The screenshot was safe;
 * their words were not.
 *
 * TWO LAYERS, and the order matters:
 *
 *   1. redact()  — deterministic. Strips paths, emails, URLs, @handles, IPs, keys.
 *                  ALWAYS runs. Never skipped.
 *   2. polish()  — a free model (openai/gpt-oss-20b:free) rewrites the redacted
 *                  text into a clean, neutral bug title.
 *
 * The model is the POLISH, never the GUARD. If OpenRouter is down, the key is
 * missing, or the model returns something implausible, we publish the redacted
 * text. We NEVER fall back to the raw text — a privacy control that depends on an
 * LLM being reachable is not a control.
 *
 * Free tier: $0. No key => redaction only, and we say so.
 */

const MODEL = 'openai/gpt-oss-20b:free';
const MAX_TITLE = 110;
const TIMEOUT_MS = 15_000;

/**
 * Strip anything that identifies a person, a machine, or a private codebase.
 * Deliberately blunt: a false positive costs a slightly vaguer title, a false
 * negative is somebody's client name on a public URL forever.
 */
export function redact(raw) {
  let text = String(raw ?? '');

  const rules = [
    // Absolute paths, incl. Windows. Do these FIRST — a path can contain an @ or a dot.
    [/\/(?:Users|home)\/[^\s"'`)]+/gi, '<path>'],
    [/[A-Za-z]:\\[^\s"'`)]+/g, '<path>'],
    [/(?:\.{0,2}\/)[\w.-]+(?:\/[\w.-]+){2,}/g, '<path>'],
    // Contact + network identifiers.
    [/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'],
    [/\bhttps?:\/\/[^\s"'`)]+/gi, '<link>'],
    [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>'],
    // Long opaque strings — tokens, keys, ids nobody needs in a bug title.
    [/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>'],
    // @handles (after emails, so we don't eat the local part of an address).
    [/(^|\s)@[\w.-]{2,}/g, '$1<user>'],
  ];
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);

  return text.replace(/\s+/g, ' ').trim();
}

const PROMPT = `Rewrite this user bug report as ONE short, neutral bug title for a public changelog.

Rules:
- Describe the DEFECT only. No greetings, no apologies, no speculation, no "user says".
- Never invent detail that is not in the report.
- Strip profanity, names of people, companies, products that are not o8, and anything already replaced with a <placeholder>.
- Plain sentence case. No trailing period. Max 100 characters.
- Output ONLY the title. No quotes, no preamble.

Report: `;

/**
 * Reject a model reply that is longer than the input, is chatty, or reintroduces
 * something the redactor removed. When in doubt we keep the redacted text — the
 * model gets to make a title prettier, never riskier.
 */
function acceptable(candidate, redacted) {
  if (!candidate) return false;
  if (candidate.length > MAX_TITLE) return false;
  // A model that starts explaining itself is not writing a title.
  if (/^(sure|here|okay|title:|the user)/i.test(candidate)) return false;
  if (candidate.includes('\n')) return false;
  // It must not resurrect an identifier the redactor stripped.
  if (/\/(Users|home)\/|@[\w.-]+\.\w|https?:\/\//i.test(candidate)) return false;
  // A title longer than what it summarizes means it padded.
  if (candidate.length > redacted.length + 20) return false;
  return true;
}

async function polish(redacted, apiKey) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://o8.run',
      'X-Title': 'o8 report sanitizer',
    },
    body: JSON.stringify({
      model: MODEL,
      // gpt-oss is a REASONING model: it spends tokens thinking before it emits
      // content. A tight cap starves it and returns content:null with
      // finish_reason "length" — the polish silently never runs. Give it room and
      // keep the thinking cheap.
      max_tokens: 800,
      temperature: 0.2,
      reasoning: { effort: 'low' },
      messages: [{ role: 'user', content: PROMPT + redacted }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);

  const payload = await response.json();
  const raw = payload?.choices?.[0]?.message?.content ?? '';
  return String(raw).replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim();
}

function clamp(text) {
  if (text.length <= MAX_TITLE) return text;
  return `${text.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

/**
 * The title safe to publish. Resolves { title, via } — `via` is 'model' or
 * 'redact', so callers can tell the operator when the polish did not run.
 * NEVER returns the raw text.
 */
export async function publicTitle(raw, { apiKey = process.env.OPENROUTER_API_KEY } = {}) {
  const redacted = redact(raw);
  if (!redacted) return { title: '(no description)', via: 'redact' };
  if (!apiKey) return { title: clamp(redacted), via: 'redact' };

  try {
    const candidate = await polish(redacted, apiKey);
    if (acceptable(candidate, redacted)) return { title: candidate, via: 'model' };
    return { title: clamp(redacted), via: 'redact' };
  } catch {
    // Down, rate-limited, timed out — the redacted text still ships. The guard
    // is the redactor; the model was only ever the polish.
    return { title: clamp(redacted), via: 'redact' };
  }
}
