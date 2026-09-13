import { readFileSync } from 'node:fs';

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

/** The configured primary used when a per-turn override is absent/refused. */
export function readOpenclawAgentPrimaryModel(configPath: string, agentId: string): string {
  try {
    const source = JSON.parse(readFileSync(configPath, 'utf8')) as {
      agents?: {
        defaults?: { model?: unknown };
        list?: Array<{ id?: unknown; model?: unknown }>;
      };
    };
    const agent = (source.agents?.list ?? []).find((candidate) => candidate.id === agentId);
    for (const candidate of [agent?.model, source.agents?.defaults?.model]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const primary = (candidate as { primary?: unknown }).primary;
        if (typeof primary === 'string' && primary.trim()) return primary.trim();
      }
    }
  } catch {
    // Older valid config shapes may not expose a primary model id.
  }
  return 'openclaw';
}
