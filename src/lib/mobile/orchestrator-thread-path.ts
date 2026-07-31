import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export const ORCHESTRATOR_HISTORY_DIR = join(getDataDir(), 'chat-history');

export function ensureOrchestratorHistoryDir(): void {
  mkdirSync(ORCHESTRATOR_HISTORY_DIR, { recursive: true });
}

export function safeOrchestratorHistoryPath(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(ORCHESTRATOR_HISTORY_DIR, `${safe}.json`);
}
