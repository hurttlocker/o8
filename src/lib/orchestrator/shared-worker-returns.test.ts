import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureV70WorkerReturnSchema } from '@/lib/db/v70-worker-return-migration';
import type { ReviewChatOrigin } from './review-continuation-origin';
import type { SharedWorkerReturnBatch } from './shared-worker-returns';

const mocks = vi.hoisted(() => ({ db: null as unknown, member: true, stopped: false,
  readState: vi.fn(), transcript: vi.fn(), origin: vi.fn() }));
vi.mock('@/lib/db', () => ({ getSqlite: () => mocks.db }));
vi.mock('@/lib/llm/chat-history-store', () => ({ readPersistedLlmChat: () => ({ history: {
  messages: [{ id: 'assistant-origin', role: 'assistant' }],
} }) }));
vi.mock('./shared-checkout-team', () => ({ assertSharedCheckoutOwner: vi.fn(), readActiveSharedCheckoutTeam: () => mocks.member
  ? { parentThreadId: 'thoughts-parent', members: [{ surfaceId: 'codex-owned:one' }, { surfaceId: 'codex-owned:two' }] } : null }));
vi.mock('./review-continuation-origin', () => ({ resolveChatTurnOrigin: mocks.origin }));
vi.mock('@/lib/runtimes/shared/owned-session/automatic-recovery', () => ({ readOwnedRecoveryState: mocks.readState }));
vi.mock('@/lib/lane/review-mode', () => ({ manualReviewRequested: () => mocks.stopped }));
vi.mock('@/lib/operator/defaults', () => ({ resolveReviewContinuationSync: () => true }));

import { registerSharedWorkerParent, reconcileSharedWorkerReturns, stopSharedWorkerReturns,
  recoverSharedWorkerReturns, listSharedWorkerReturns } from './shared-worker-returns';

const origin: ReviewChatOrigin = { threadId: 'thoughts-parent', turnId: 'assistant-origin',
  backend: 'codex', model: 'test-model', effort: 'low', mode: 'fleet', pickedMode: 'fast', permissionMode: 'plan' };
let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(':memory:');
  ensureV70WorkerReturnSchema(sqlite);
  mocks.db = sqlite; mocks.member = true; mocks.stopped = false;
  mocks.origin.mockReturnValue({ kind: 'bound', origin });
  mocks.readState.mockImplementation(async (surface: string) => ({ owned: true, runId: `run-${surface}`,
    outcome: 'finished', startedAt: new Date(100).toISOString(), interrupted: false }));
  mocks.transcript.mockImplementation(async (surface: string) => [{ id: `run-${surface}:answer`, role: 'assistant', text: 'Actual result', timestamp: 200 }]);
});
afterEach(() => { sqlite.close(); vi.clearAllMocks(); });

function register(surfaceId = 'codex-owned:one') {
  registerSharedWorkerParent({ repoPath: '/repo', surfaceId, origin });
}
function hooks(run = vi.fn(async (_batch: SharedWorkerReturnBatch) => {})) {
  return { readTranscript: mocks.transcript, isBusy: () => false, run };
}
describe('shared worker parent delivery', () => {
  it('batches two finished runs into their exact parent and deduplicates later ticks', async () => {
    register(); register('codex-owned:two');
    const io = hooks();
    await reconcileSharedWorkerReturns(io);
    await reconcileSharedWorkerReturns(io);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.run.mock.calls[0]?.[0]).toMatchObject({ repoPath: '/repo', origin,
      returns: [expect.objectContaining({ summary: 'Actual result' }), expect.objectContaining({ summary: 'Actual result' })] });
    expect(listSharedWorkerReturns('thoughts-parent').map(row => row.status)).toEqual(['delivered', 'delivered']);
  });
  it('keeps results pending while busy, then delivers once after recovery', async () => {
    register(); const io = { ...hooks(), isBusy: () => true };
    await reconcileSharedWorkerReturns(io);
    expect(io.run).not.toHaveBeenCalled();
    recoverSharedWorkerReturns();
    await reconcileSharedWorkerReturns({ ...io, isBusy: () => false });
    expect(io.run).toHaveBeenCalledTimes(1);
  });
  it('Stop while idle fences a late result, including after a restart', async () => {
    register(); stopSharedWorkerReturns('/repo', 'thoughts-parent'); recoverSharedWorkerReturns();
    const io = hooks(); await reconcileSharedWorkerReturns(io);
    expect(io.run).not.toHaveBeenCalled();
    expect(listSharedWorkerReturns('thoughts-parent')[0]).toMatchObject({ status: 'held' });
  });
  it('Stop during launch fences the parent before the worker surface exists', async () => {
    stopSharedWorkerReturns('/repo', 'thoughts-parent');
    register(); const io = hooks(); await reconcileSharedWorkerReturns(io);
    expect(io.run).not.toHaveBeenCalled();
    expect(listSharedWorkerReturns('thoughts-parent')[0]).toMatchObject({ status: 'held' });
  });
  it('refuses changed routing or ownership and never sends to an unrelated chat', async () => {
    register(); mocks.origin.mockReturnValue({ kind: 'refused', reason: 'Changed binding' });
    const io = hooks(); await reconcileSharedWorkerReturns(io);
    expect(io.run).not.toHaveBeenCalled();
    expect(listSharedWorkerReturns('thoughts-other')).toEqual([]);
    expect(listSharedWorkerReturns('thoughts-parent')[0]).toMatchObject({ status: 'held' });
  });
  it('reports failed and interrupted children without retrying them', async () => {
    register(); mocks.readState.mockResolvedValue({ owned: true, runId: 'failed-run', outcome: 'failed' });
    const io = hooks(); await reconcileSharedWorkerReturns(io);
    expect(io.run.mock.calls[0]?.[0]).toMatchObject({ returns: [expect.objectContaining({ outcome: 'failed' })] });
  });
  it('a later worker run is distinct, and never reuses the previous transcript result', async () => {
    register(); const io = hooks(); await reconcileSharedWorkerReturns(io);
    mocks.readState.mockResolvedValue({ owned: true, runId: 'next', outcome: 'finished', startedAt: new Date(300).toISOString() });
    await reconcileSharedWorkerReturns(io);
    expect(io.run).toHaveBeenCalledTimes(2);
    expect(listSharedWorkerReturns('thoughts-parent').at(-1)?.summary).not.toBe('Actual result');
  });
  it('attributes by recorded run identity when process clocks differ, never by a coincident timestamp', async () => {
    register();
    mocks.readState.mockResolvedValue({ owned: true, runId: 'current', outcome: 'finished',
      startedAt: new Date(300).toISOString(), finishedAt: new Date(400).toISOString() });
    mocks.transcript.mockResolvedValue([
      { id: 'current:answer', role: 'assistant', text: 'Current answer', timestamp: 100 },
      { id: 'old:answer', role: 'assistant', text: 'Previous answer', timestamp: 350 },
    ]);
    const io = hooks(); await reconcileSharedWorkerReturns(io);
    expect(io.run.mock.calls[0]?.[0].returns[0].summary).toBe('Current answer');
  });
  it('does not blindly replay a model turn whose outcome was lost on restart', async () => {
    register(); const io = { ...hooks(), isBusy: () => true }; await reconcileSharedWorkerReturns(io);
    sqlite.prepare("UPDATE shared_worker_returns SET status = 'running'").run();
    recoverSharedWorkerReturns();
    await reconcileSharedWorkerReturns({ ...io, isBusy: () => false });
    expect(io.run).not.toHaveBeenCalled();
    expect(listSharedWorkerReturns('thoughts-parent')[0]).toMatchObject({ status: 'held', reason: expect.stringContaining('interrupted') });
  });
});
