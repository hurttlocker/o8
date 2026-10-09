import 'server-only';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { listRuntimeIdentitiesForServer } from '@/lib/runtime/identity-catalog';
import type { UsageProviderKind } from './history-types';

export interface HistoryRoot { provider: UsageProviderKind; path: string; format: 'jsonl' | 'opencode' | 'antigravity' }
export async function resolveHistoryRoots(options: { identities?: (runtime: string) => Promise<{ configHomeRef: string }[]> } = {}): Promise<HistoryRoot[]> {
  const home = homedir();
  const roots: HistoryRoot[] = [];
  for (const [runtime, provider, defaultHome, leaf] of [
    ['codex', 'codex', process.env.CODEX_HOME?.trim() || join(home, '.codex'), 'sessions'],
    ['claude-code', 'claude', process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'projects'],
  ] as const) {
    const homes = new Set([defaultHome, ...(await (options.identities ?? listRuntimeIdentitiesForServer)(runtime)).map(identity => identity.configHomeRef)]);
    for (const configHome of homes) {
      roots.push({ provider, path: join(configHome, leaf), format: 'jsonl' });
      if (provider === 'codex') roots.push({ provider, path: join(configHome, 'archived_sessions'), format: 'jsonl' });
    }
  }
  roots.push({ provider: 'grok', path: join(process.env.GROK_HOME?.trim() || join(home, '.grok'), 'sessions'), format: 'jsonl' });
  roots.push({ provider: 'opencode', path: process.env.OPENCODE_DATA_DIR?.trim()
    || join(process.env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'opencode'), format: 'opencode' });
  const antigravity = process.env.ANTIGRAVITY_DATA_DIR?.trim();
  for (const path of antigravity ? [antigravity] : [
    ...['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map(name => join(home, '.gemini', name)),
    join(home, '.config', 'antigravity'),
  ]) {
    const nested = join(path, 'conversations');
    roots.push({ provider: 'antigravity', path: (await stat(nested).catch(() => null))?.isDirectory() ? nested : path, format: 'antigravity' });
  }
  return roots;
}
