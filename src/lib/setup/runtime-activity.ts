import 'server-only';

import { opendir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { defaultCodexHome } from '@/lib/codex/discovery-store';
import { isCodexModelId, isSupportedModelId } from '@/lib/models';
import type { RuntimeActivity } from './runtime-recommendation';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Counts recently modified session files, never reads transcripts or shell history. */
export async function readRuntimeActivity(options: {
  codexHome?: string; claudeHome?: string; now?: number; maxEntries?: number; budgetMs?: number;
} = {}): Promise<RuntimeActivity> {
  const now = options.now ?? Date.now();
  const deadline = Date.now() + (options.budgetMs ?? 1_500);
  const limit = options.maxEntries ?? 6_000;
  const scan = async (root: string, depth: number) => {
    let visited = 0;
    let count = 0;
    let complete = true;
    const walk = async (directory: string, remaining: number): Promise<void> => {
      try {
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (++visited > limit || Date.now() > deadline) { complete = false; break; }
          if (entry.isDirectory() && remaining > 0 && entry.name !== 'subagents') {
            await walk(join(directory, entry.name), remaining - 1);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
            const info = await stat(join(directory, entry.name));
            if (info.mtimeMs >= now - WEEK_MS && info.mtimeMs <= now) count += 1;
          }
          if (!complete) break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      }
    };
    await walk(root, depth);
    return { count, complete };
  };
  const [codex, claude] = await Promise.all([
    scan(join(options.codexHome ?? defaultCodexHome(), 'sessions'), 3),
    scan(join(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'), 1),
  ]);
  return { codex: codex.count, claude: claude.count, complete: codex.complete && claude.complete };
}

export async function readLocalLeadModels(): Promise<Partial<Record<'codex' | 'claude', string>>> {
  const boundedRead = async (path: string) => {
    if ((await stat(path)).size > 256_000) throw new Error('Configuration exceeds setup read limit');
    return readFile(path, 'utf8');
  };
  const [codex, claude] = await Promise.all([
    boundedRead(join(defaultCodexHome(), 'config.toml')).then((text) => parse(text).model).catch(() => null),
    boundedRead(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'))
      .then((text) => (JSON.parse(text) as { model?: unknown }).model).catch(() => null),
  ]);
  return {
    ...(isCodexModelId(codex) ? { codex } : {}),
    ...(typeof claude === 'string' && claude.startsWith('claude-') && isSupportedModelId(claude) ? { claude } : {}),
  };
}
