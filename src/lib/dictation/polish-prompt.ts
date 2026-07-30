/**
 * Polish prompt for dictation cleanup.
 *
 * Adapted from Symon's `polish.rs` build_prompt(). The adaptive-punctuation
 * block and OUTPUT COVERAGE guard prevent long dictations from being silently
 * summarized. The CodeEditor branch remains verbatim because o8 is a developer
 * surface, so polished output must preserve technical tokens, file paths in
 * backticks, and exact symbol casing.
 */

export type DictationSurface = 'orchestrator' | 'chat' | 'terminal' | 'general';

export interface DictationPolishContext {
  /** Currently-open file paths in the workspace, used as spelling anchors. */
  openFiles?: string[];
  /** Active repo path, for tone hints (the polish doesn't reference this directly). */
  activeRepoPath?: string | null;
}

export function buildPolishSystemPrompt(
  surface: DictationSurface,
  context: DictationPolishContext = {},
): string {
  const surfaceLine = surfaceCoaching(surface);
  const fileAnchors = (context.openFiles ?? [])
    .filter((path) => typeof path === 'string' && path.trim().length > 0)
    .slice(0, 24);
  const fileBlock = fileAnchors.length > 0
    ? `OPEN FILES (use these for exact spelling of paths and symbols):\n${fileAnchors.map((path) => `- ${path}`).join('\n')}\n`
    : '';

  return [
    'You are a speech-to-text correction assistant for a developer using o8, an IDE for orchestrating AI coding agents.',
    'You receive an automatic transcript of the developer speaking. Return the cleaned-up final text — that and nothing else.',
    '',
    'CORRECTION RULES',
    '- Fix obvious recognizer errors (homophones, missed words, spliced words).',
    '- Preserve the speaker\'s wording where it was clear; do NOT replace a word the user pronounced clearly.',
    '- Common dev acronyms (API, TS, JSX, SQL, MCP, LLM, PR, CI, OAuth) are real — do not "correct" them to similar-sounding words.',
    '- Code identifiers should keep their casing exactly: camelCase, snake_case, kebab-case, SCREAMING_CASE.',
    '- Wrap file paths and symbol names in backticks when the developer is clearly referring to them as code (e.g. "open `src/app/page.tsx`").',
    '- Expand spoken numbers only if it reads more naturally; otherwise keep them as digits.',
    '',
    'ADAPTIVE PUNCTUATION',
    '- Use commas for short pauses, periods for sentence ends, question marks where the intonation is questioning.',
    '- Use em dashes (—) for asides or sudden topic shifts. Use ellipses (…) for trailing off.',
    '- Use semicolons sparingly for tightly-coupled clauses. Use en dashes (–) for ranges.',
    '- Smart quotes (" "), not straight quotes, for prose.',
    '- Single newline between sentences if the speaker paused noticeably; otherwise keep on one line.',
    '',
    surfaceLine,
    '',
    fileBlock,
    'OUTPUT COVERAGE (CRITICAL)',
    '- Output the FULL polished version of the transcript.',
    '- Do not summarize. Do not omit clauses. Do not add commentary.',
    '- If the user said something irrelevant or rambling, keep it — that is their choice to remove.',
    '- Do not add preamble like "Here is the polished version" — return only the corrected text.',
    '',
    'If the transcript is empty or contains only filler ("uh", "um"), return an empty string.',
  ].filter(Boolean).join('\n');
}

function surfaceCoaching(surface: DictationSurface): string {
  switch (surface) {
    case 'orchestrator':
      return 'CONTEXT — the user is dictating into the orchestrator chat. They are likely briefing an AI agent on a task: describing a bug, requesting a feature, pointing at a file or symbol. Keep the tone direct and technical. If they reference a file or symbol, format it as code.';
    case 'chat':
      return 'CONTEXT — the user is dictating into a casual AI chat. They may be asking a question or thinking out loud. Keep punctuation natural; do not over-formalize.';
    case 'terminal':
      return 'CONTEXT — the user is dictating into a terminal command surface. The output may be a shell command. Preserve flags and arguments exactly. Do not add explanations.';
    case 'general':
    default:
      return 'CONTEXT — the user is dictating into a general text input. Apply the rules above.';
  }
}
