export interface PlanTranscriptMessage {
  role?: string;
  content?: unknown;
  text?: unknown;
  toolCalls?: unknown;
}

const NUMBERED_STEP_PATTERN = /(?:^|\n)\s*\d+[.)]\s+\S/g;
const CHECKBOX_STEP_PATTERN = /(?:^|\n)\s*[-*]\s+\[[ xX]\]\s+\S/g;

/** Pulls each numbered / checkbox step's text, without its marker. */
const STEP_LINE_PATTERN = /^\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+(\S.*)$/;

/**
 * A step that narrates something that ALREADY happened.
 *
 * A recap and a plan are both numbered lists — which is all this used to check,
 * so "1. You asked me to build X  2. I created the page…" filed itself as the
 * session's plan and rendered under "Show the first-turn plan" (Q 2026-07-16,
 * caught in the wild).
 *
 * Deliberately anchored to the subject: "I created the page" is history, while
 * "Create the page" is a step. Matching past-tense verbs anywhere in the line
 * would reject real steps that merely reference prior state — e.g. "Add the
 * flag the operator asked for".
 */
const RETROSPECTIVE_STEP = new RegExp(
  [
    // "You asked me to…", "I created…", "We already added…"
    '^(?:you|i|we)\\s+(?:\\w+\\s+){0,2}?(?:asked|added|created|updated|shared|changed|fixed|built|ran|removed|made|started|opened|sent|gave|moved|renamed|deleted|wrote|found|saw|noticed|tried)\\b',
    // "Now you're asking…", "Then I opened…"
    '^(?:now|then|next|after that|finally),?\\s+(?:you|i|we)\\b',
    // "Done — …", "Fixed: …"
    '^(?:done|fixed|shipped|completed)\\b',
  ].join('|'),
  'i',
);

function readMessageText(message: PlanTranscriptMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  return '';
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function planStepLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(STEP_LINE_PATTERN);
    if (match?.[1]) out.push(match[1].trim());
  }
  return out;
}

/**
 * A recap lists what happened; a plan lists what's to do. Judged by weight
 * rather than a single line: a real plan can open with one "I created the
 * scaffold" before proposing the rest, while a recap is retrospective
 * throughout.
 */
export function isRetrospective(steps: readonly string[]): boolean {
  if (steps.length === 0) return false;
  const past = steps.filter((step) => RETROSPECTIVE_STEP.test(step)).length;
  return past * 2 >= steps.length;
}

function hasPlanShape(text: string): boolean {
  const numbered = countMatches(text, NUMBERED_STEP_PATTERN);
  const checkboxes = countMatches(text, CHECKBOX_STEP_PATTERN);
  if (numbered < 2 && checkboxes < 2) return false;
  return !isRetrospective(planStepLines(text));
}

function isToolCallOnly(message: PlanTranscriptMessage, text: string): boolean {
  return Array.isArray(message.toolCalls) && message.toolCalls.length > 0 && !text.trim();
}

export function extractPlanFromTranscript(messages: readonly PlanTranscriptMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    const text = readMessageText(message).trim();
    if (!text || isToolCallOnly(message, text)) continue;
    if (hasPlanShape(text)) return text;
  }

  return null;
}
