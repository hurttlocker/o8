import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RuntimeTelemetry } from './types';

/** Billing totals re-read the prompt once per request. Only the latest prompt
 * measures context pressure; cached input is already included in input_tokens. */
export async function readCodexContext(paths: string[]): Promise<Pick<RuntimeTelemetry, 'contextTokens' | 'contextSource'>> {
  let context: Pick<RuntimeTelemetry, 'contextTokens' | 'contextSource'> = {};
  for (const filePath of paths) {
    const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
          const tokens = entry.payload.info?.last_token_usage?.input_tokens;
          if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
            context = { contextTokens: tokens, contextSource: 'codex-token-count-last-input' };
          }
        } catch { /* A live JSONL tail may be incomplete. */ }
      }
    } catch { /* Missing or rotating logs have no context measurement. */ }
  }
  return context;
}
