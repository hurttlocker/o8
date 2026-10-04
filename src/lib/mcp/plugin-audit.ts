import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface PluginAuditEntry {
  at: string;
  actor: 'plugin';
  surface: 'chatgpt';
  clientId: string;
  machineId: string;
  callId: string;
  tool: string;
  phase: 'requested' | 'finished';
  outcome?: 'success' | 'refused' | 'unknown';
  missionId?: string;
  packetId?: string;
  argumentHash: string;
}

/** Local audit stores identity and a digest, never prompts, credentials, or results. */
export function appendPluginAudit(entry: PluginAuditEntry, dataDir = getDataDir()): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dataDir, 'plugin-audit.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readPluginAudit(dataDir = getDataDir()): PluginAuditEntry[] {
  try {
    return readFileSync(join(dataDir, 'plugin-audit.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).slice(-100).map((line) => JSON.parse(line) as PluginAuditEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
