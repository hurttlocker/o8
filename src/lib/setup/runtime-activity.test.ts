import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRuntimeActivity } from './runtime-activity';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('bounded local runtime activity', () => {
  it('counts recent top-level sessions from both tools without parsing contents or subagents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o8-runtime-activity-'));
    roots.push(root);
    const now = Date.now();
    const codexHome = join(root, 'codex');
    const claudeHome = join(root, 'claude');
    const files = [
      [join(codexHome, 'sessions', '2026', '09', '25', 'session.jsonl'), now - 1_000],
      [join(codexHome, 'sessions', '2025', '01', '01', 'resumed.jsonl'), now - 1_000],
      [join(codexHome, 'sessions', '2026', '09', '01', 'old.jsonl'), now - 9 * 86_400_000],
      [join(claudeHome, 'projects', 'project', 'human.jsonl'), now - 1_000],
      [join(claudeHome, 'projects', 'project', 'agent-worker.jsonl'), now - 1_000],
      [join(claudeHome, 'projects', 'project', 'human', 'subagents', 'worker.jsonl'), now - 1_000],
    ] as const;
    for (const [file, modified] of files) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'This is deliberately not JSON. Contents must not be read.');
      await utimes(file, new Date(modified), new Date(modified));
    }
    expect(await readRuntimeActivity({ codexHome, claudeHome, now })).toEqual({ codex: 2, claude: 1, complete: true });
    expect((await readRuntimeActivity({ codexHome, claudeHome, now, maxEntries: 1 })).complete).toBe(false);
  });

  it('treats absent history as no evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o8-runtime-activity-empty-'));
    roots.push(root);
    expect(await readRuntimeActivity({ codexHome: root, claudeHome: root })).toEqual({ codex: 0, claude: 0, complete: true });
  });
});
