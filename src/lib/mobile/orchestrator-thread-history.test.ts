import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempHomes: string[] = [];

async function loadHistoryModule() {
  const home = mkdtempSync(join(tmpdir(), 'o8-orch-history-'));
  tempHomes.push(home);
  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  return import('./orchestrator-thread-history');
}

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('orchestrator thread history persistence', () => {
  it('can pair a streamed assistant message with the exact persisted user timestamp', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'hello',
      backend: 'codex',
      timestampMs: 1234,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-1234',
      content: 'hi',
      backend: 'codex',
      timestampMs: 1234,
    });

    const persisted = JSON.parse(readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8'));
    expect(persisted.messages.map((message: { id?: string }) => message.id)).toEqual([
      'user-1234',
      'assistant-1234',
    ]);
  });

  it('reuses cached parses until the history file mtime or size changes', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', title: 'Alpha' });
    const filePath = history.safeOrchestratorHistoryPath(thread.id);

    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe('Alpha');
    const originalStat = statSync(filePath);
    const raw = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, raw.replace('"Alpha"', '"Bravo"'));
    utimesSync(filePath, originalStat.atimeMs / 1000, originalStat.mtimeMs / 1000);

    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe('Alpha');
    writeFileSync(filePath, raw.replace('"Alpha"', '"Charlie"'));

    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe('Charlie');
  });
});
