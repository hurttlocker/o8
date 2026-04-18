export interface PlanTranscriptMessage {
  role?: string;
  content?: unknown;
  text?: unknown;
  toolCalls?: unknown;
}

const NUMBERED_STEP_PATTERN = /(?:^|\n)\s*\d+[\.)]\s+\S/g;
const CHECKBOX_STEP_PATTERN = /(?:^|\n)\s*[-*]\s+\[[ xX]\]\s+\S/g;

function readMessageText(message: PlanTranscriptMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  return '';
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function hasPlanShape(text: string): boolean {
  return countMatches(text, NUMBERED_STEP_PATTERN) >= 2
    || countMatches(text, CHECKBOX_STEP_PATTERN) >= 2;
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
