import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-home-persistence-'));
const registryPath = join(dataDir, 'repos.json');
const registrySeed = {
  version: 1,
  repos: [{ id: 'repo-existing', localPath: '/tmp/existing-repo', name: 'existing' }],
};
writeFileSync(registryPath, `${JSON.stringify(registrySeed, null, 2)}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { resolveOrchestratorMessageRepoPath } = await import('@/lib/orchestrator/repo-path');
const {
  appendMobileOrchestratorUserMessage,
  safeOrchestratorHistoryPath,
} = await import('@/lib/mobile/orchestrator-thread-history');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('orchestrator home persistence', () => {
  it('persists the resolved home path without registering home as a repo', () => {
    const threadId = 'thoughts-home-persistence';
    const repoPath = resolveOrchestratorMessageRepoPath({
      type: 'orchestrator-send',
      repoPath: '~',
    });
    expect(repoPath).toBe(homedir());

    appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath: repoPath!,
      message: 'hello from home',
    });

    const history = JSON.parse(
      readFileSync(safeOrchestratorHistoryPath(threadId), 'utf8'),
    ) as { repoPath?: string };
    expect(history.repoPath).toBe(homedir());
    expect(history.repoPath).not.toBe('~');

    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as typeof registrySeed;
    expect(registry).toEqual(registrySeed);
    expect(JSON.stringify(registry)).not.toContain(homedir());
    expect(JSON.stringify(registry)).not.toContain('"~"');
  });
});
