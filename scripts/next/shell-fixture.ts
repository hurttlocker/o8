/** Second disposable workspace for shell switching; read through production routes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function seedShellWorkspace(dataDir: string, root: string) {
  const repo = join(root, 'second-repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const seed = { id: 'thoughts-shell-second', title: 'Second workspace session', messages: [
    { id: 'shell-second-ready', role: 'assistant', content: 'Second workspace ready', timestamp: 1790812800000 },
  ] };
  writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
    repoPath: repo, backend: 'pi', model: 'pi', orchestratorVisible: true, savedAt: '2026-10-01T00:00:00.000Z' }));
  return seed;
}
