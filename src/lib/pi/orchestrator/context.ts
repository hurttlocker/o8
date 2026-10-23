import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getDataDir } from '@/lib/data-dir-migration';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';
import { newestPiSessionFile } from '@/lib/pi/sdk/session-files';

export function piOrchestratorStateDir(name: string, root = join(getDataDir(), 'pi', 'orchestrator')): string {
  return join(root, createHash('sha256').update(name).digest('hex').slice(0, 32));
}

/** Pi and o8 share this session. Session stats are cumulative; assistant usage
 * entries describe individual model requests, with cache tokens separate. */
export async function readPiOrchestratorContext(repoPath: string, threadId: string): Promise<RuntimeTelemetry> {
  const name = sessionNameForRepo('pi-orchestrator', repoPath, threadId);
  const file = await newestPiSessionFile(join(piOrchestratorStateDir(name), 'sessions'));
  if (!file) return {};
  let context: RuntimeTelemetry = {};
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
        context = {};
        if (!entry.message.usage) continue;
        const usage = entry.message.usage;
        const parts = [usage.input ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0];
        if (!parts.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) continue;
        const tokens = parts.reduce((sum, value) => sum + value, 0);
        if (tokens > 0) context = { contextTokens: tokens, contextSource: 'pi-last-request-input' };
      } catch { /* Incomplete JSONL tail. */ }
    }
  } catch { /* A rotating or unavailable session uses the transcript estimate. */ }
  return context;
}
