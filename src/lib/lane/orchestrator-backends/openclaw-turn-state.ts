export interface OpenclawPayloadBlock {
  payloads?: Array<{ text?: string }>;
  meta?: Record<string, unknown> & { finalAssistantVisibleText?: string };
}

export interface OpenclawAgentResult extends OpenclawPayloadBlock {
  status?: string;
  result?: OpenclawPayloadBlock;
}

export function resolveOpenclawPromptSeeded(
  current: boolean,
  exitCode: number | null,
  assistantText: string,
): boolean {
  return current || (exitCode === 0 && assistantText.trim().length > 0);
}
