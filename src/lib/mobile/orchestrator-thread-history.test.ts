import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_MODE_DIRECTIVES } from '@/lib/orchestrator/composer-wire';

const tempHomes: string[] = [];
const previousO8DataDir = process.env.O8_DATA_DIR;
const previousCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;

async function loadHistoryModule() {
  const home = mkdtempSync(join(tmpdir(), 'o8-orch-history-'));
  tempHomes.push(home);
  process.env.O8_DATA_DIR = home;
  process.env.CORTEX_IDE_DATA_DIR = home;
  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  return import('./orchestrator-thread-history');
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('node:os');
  vi.resetModules();
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  if (previousCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousCortexDataDir;
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('orchestrator thread history persistence', () => {
  it('repairs exact legacy composer preambles in bubbles and auto-derived titles', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({
      repoPath: '/tmp/repo',
      title: '[Mode: Solo] Work directly in this session',
    });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: `${COMPOSER_MODE_DIRECTIVES.solo}\n\nFix the title source`,
      backend: 'codex',
      timestampMs: 1_000,
    });

    history.repairComposerPreamblePollution();

    const persisted = JSON.parse(
      readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8'),
    ) as {
      title?: string;
      titleSource?: string;
      messages: Array<{ role?: string; content?: string }>;
    };
    expect(persisted.messages.find((message) => message.role === 'user')?.content)
      .toBe('Fix the title source');
    expect(persisted.title).toBe('Fix the title source');
    expect(persisted.titleSource).toBe('code');
  });

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

  it('rewinds an undone turn from its exact client message id', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'keep this turn',
      messageId: 'orch-user-send-1',
      backend: 'codex',
      timestampMs: 1000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-1000',
      content: 'kept',
      backend: 'codex',
      timestampMs: 1001,
    });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'undo this turn',
      messageId: 'orch-user-send-2',
      backend: 'codex',
      timestampMs: 2000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-2000',
      content: 'partial response',
      backend: 'codex',
      timestampMs: 2001,
    });

    history.truncateMobileOrchestratorThreadFromMessage({
      tabId: thread.id,
      messageId: 'orch-user-send-2',
    });

    const persisted = JSON.parse(readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8'));
    expect(persisted.messages.map((message: { id?: string }) => message.id)).toEqual([
      'orch-user-send-1',
      'assistant-1000',
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

  it('does not derive missing orchestrator titles from prompt text', async () => {
    const history = await loadHistoryModule();
    const tabId = 'thoughts-1783108800000';

    history.appendMobileOrchestratorUserMessage({
      tabId,
      repoPath: '/tmp/repo',
      message: 'The hygiene packet is awaiting review. Review the diff properly.',
      backend: 'codex',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });

    const listed = history.listMobileOrchestratorThreads()[0];
    expect(listed?.title).toContain('2026-07-03');
    expect(listed?.title).not.toContain('hygiene packet');
  });

  it('does not turn a normal message append into a fresh reveal request', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', reveal: false });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'keep this thread quiet',
      backend: 'codex',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });

    expect(history.listMobileOrchestratorRevealRequests('2026-07-07T00:00:00.000Z')).toEqual([]);
  });

  it('persists OpenClaw agent ids on projected mobile thread rows', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({
      repoPath: '/tmp/repo',
      backend: 'openclaw',
      agent: 'main',
    });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'hello mister',
      backend: 'openclaw',
      agent: 'main',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });

    const listed = history.listMobileOrchestratorThreads({ backend: 'openclaw' })[0];
    expect(listed?.backend).toBe('openclaw');
    expect(listed?.agent).toBe('main');
  });

  it('projects terminal OpenClaw failures as failed instead of permanently busy', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({
      repoPath: '/tmp/repo',
      backend: 'openclaw',
      agent: 'main',
    });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'trigger gateway failure',
      backend: 'openclaw',
      agent: 'main',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });
    expect(history.listMobileOrchestratorThreads({ backend: 'openclaw' })[0]?.status).toBe('busy');

    history.markMobileOrchestratorThreadFailed({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      error: 'openclaw gateway exited or failed to spawn before becoming ready',
      backend: 'openclaw',
      agent: 'main',
      timestampMs: new Date('2026-07-07T21:29:01.000Z').getTime(),
    });

    const listed = history.listMobileOrchestratorThreads({ backend: 'openclaw' })[0];
    expect(listed?.status).toBe('failed');
    expect(listed?.agent).toBe('main');
  });

  it('async stat token matches the sync token across states', async () => {
    const history = await loadHistoryModule();

    // Empty history dir: both tokens agree.
    expect(await history.mobileOrchestratorThreadHistoryStatTokenAsync()).toBe(
      history.mobileOrchestratorThreadHistoryStatToken(),
    );

    const first = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', title: 'Alpha' });
    history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', title: 'Bravo' });
    expect(await history.mobileOrchestratorThreadHistoryStatTokenAsync()).toBe(
      history.mobileOrchestratorThreadHistoryStatToken(),
    );

    // A file mutation must move both tokens in lockstep.
    const before = history.mobileOrchestratorThreadHistoryStatToken();
    const filePath = history.safeOrchestratorHistoryPath(first.id);
    const raw = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, raw.replace('"Alpha"', '"Charlie"'));
    const afterSync = history.mobileOrchestratorThreadHistoryStatToken();
    expect(afterSync).not.toBe(before);
    expect(await history.mobileOrchestratorThreadHistoryStatTokenAsync()).toBe(afterSync);
  });
});
