import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

const mocks = vi.hoisted(() => ({ beforeProject: null as (() => Promise<void>) | null,
  send: vi.fn(async (_repo: string, _message: string, emit: (event: OrchestratorEvent) => void, options: OrchestratorTurnOptions) => {
    emit({ type: 'turn_receipt', leadModel: options.model!, effort: options.thinkingEffort! });
    emit({ type: 'text', text: 'Queued answer.' });
    emit({ type: 'done', sessionId: 'queue-provider-session', cost: null });
  }) }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: (id: OrchestratorBackend['id']) => ({
  id, label: id, ensureSession: () => ({ sessionName: 'queued-session', status: 'ready' }),
  peekSession: () => ({ sessionName: 'queued-session', status: 'ready' }), sendTurn: mocks.send,
}) }));
vi.mock('@/lib/ws-server/orchestrator-project-context', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ws-server/orchestrator-project-context')>();
  return { ...actual, prepareOrchestratorProjectTurn: async (input: Parameters<typeof actual.prepareOrchestratorProjectTurn>[0]) => {
    await mocks.beforeProject?.(); return actual.prepareOrchestratorProjectTurn(input);
  } };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-queue-exec-')));
const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'chat-history'));
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'queue.db'));
const threadId = 'thoughts-queued-execution'; const target = { repoPath: repo, threadId };
const historyPath = join(root, 'chat-history', `${threadId}.json`);
const { getSqlite, closeDb } = await import('@/lib/db');
const queue = await import('@/lib/orchestrator/composer-queue');
const { POST } = await import('@/app/api/orchestrator/composer-queue/route');
const { createChatContinuationHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
const { withImmediateComposerSend, orchestratorContinuationAbortKey } = await import('@/lib/ws-server/composer-send-admission');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const active = new Map<string, AbortController>(); let busy = false;
const hooks = { readTranscript: async () => [], isBusy: () => busy || active.size > 0,
  registerAbort: (_repo: string, origin: { threadId: string }, controller: AbortController) => {
    if (active.has(origin.threadId)) throw new Error('Already working');
    active.set(origin.threadId, controller); return () => { active.delete(origin.threadId); };
  }, publish: vi.fn() };
const base: ComposerQueuePayload = { text: 'Visible operator words', wireMessage: 'Private context\n\nVisible operator words',
  images: [{ name: 'proof.png', dataUri: 'data:image/png;base64,YQ==' }], routing: {
    backend: 'codex', model: 'selected-model', effort: 'low', serviceTier: 'priority', permissionMode: 'plan',
    mode: 'single', pickedMode: 'solo', collide: false,
  } };
async function enqueue(id: string, payload = base) {
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, id, intent: 'send-next', payload }),
  }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue'); mocks.send.mockClear(); mocks.beforeProject = null; busy = false;
  writeFileSync(historyPath, JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('drains API-saved messages FIFO without a mounted composer, retains exact routing/images and never replays', async () => {
  await enqueue('queue-first'); await enqueue('queue-second', { ...base, text: 'Second words', wireMessage: 'Second payload' });
  closeDb(); const heartbeat = createChatContinuationHeartbeat(hooks); busy = true; heartbeat();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).not.toHaveBeenCalled();
  busy = false; heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-first')?.status).toBe('applied'));
  expect(queue.readComposerSend('queue-second')?.status).toBe('queued');
  expect(mocks.send.mock.calls[0][3]).toMatchObject({ threadId, model: 'selected-model', thinkingEffort: 'low',
    permissionMode: 'plan', orchestrationMode: 'single', serviceTier: 'priority', attachments: base.images });
  const history = readPersistedLlmChat(threadId)!.history;
  expect(history.messages.find(row => row.role === 'user')?.content).toBe(base.text);
  expect(history.messages.find(row => row.role === 'user')?.media).toHaveLength(1);
  expect(hooks.publish).toHaveBeenCalledWith(threadId, 'queued-session', 'turn-start', expect.objectContaining({
    userMessageId: 'review-user-assistant-queued-queue-first', assistantMessageId: 'assistant-queued-queue-first', message: base.text,
  }));
  expect(mocks.send.mock.calls[0][1]).toContain('Private context');
  heartbeat(); await vi.waitFor(() => expect(queue.readComposerSend('queue-second')?.status).toBe('applied'));
  closeDb(); createChatContinuationHeartbeat(hooks)(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(mocks.send).toHaveBeenCalledTimes(2);
});
it('Stop during asynchronous preparation holds the message before a provider sees it', async () => {
  let release!: () => void; let entered = false;
  mocks.beforeProject = async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); };
  await enqueue('queue-stopped'); const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(entered).toBe(true));
  queue.holdComposerSends(target); release();
  await vi.waitFor(() => expect(active.size).toBe(0));
  expect(queue.readComposerSend('queue-stopped')).toMatchObject({ status: 'held', admittedAt: null });
  expect(mocks.send).not.toHaveBeenCalled(); expect(readPersistedLlmChat(threadId)?.history.messages).toEqual([]);
});
it('does not let a stale window overtake the queue or a heartbeat overtake an accepted preparing send', async () => {
  await enqueue('queue-existing'); const direct = vi.fn(async () => {});
  await expect(withImmediateComposerSend(target, direct)).rejects.toThrow('saved messages'); expect(direct).not.toHaveBeenCalled();
  queue.cancelComposerSend(target, 'queue-existing');
  let release!: () => void;
  const sending = withImmediateComposerSend(target, () => new Promise<void>(resolve => { release = resolve; }));
  await enqueue('queue-after-direct'); const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).not.toHaveBeenCalled();
  release(); await sending; heartbeat(); await vi.waitFor(() => expect(queue.readComposerSend('queue-after-direct')?.status).toBe('applied'));
});
it('uses captured Collide routing', async () => {
  await enqueue('queue-collide', { ...base, routing: { ...base.routing, collide: true, mode: 'fleet', pickedMode: 'moa' } });
  const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-collide')?.status).toBe('applied'));
  expect(mocks.send.mock.calls[0][3]).toMatchObject({ collideBaseBackend: 'codex', orchestrationMode: 'fleet' });
  expect(readPersistedLlmChat(threadId)!.history.messages.at(-1)).toMatchObject({ backend: 'collide', receipt: { mode: 'moa' } });
});
it('canonicalizes equivalent repository paths for FIFO, Stop and cancellation', async () => {
  const alias = join(root, 'repo-alias'); symlinkSync(repo, alias);
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, repoPath: alias,
      id: 'queue-aliased', intent: 'send-next', payload: base }),
  }));
  expect(response.status).toBe(200);
  expect(queue.readComposerSend('queue-aliased')?.repoPath).toBe(repo);
  expect(queue.listQueuedComposerSends({ ...target, repoPath: `${repo}/` })).toHaveLength(1);
  await expect(withImmediateComposerSend(target, async () => {})).rejects.toThrow('saved messages');
  queue.holdComposerSends({ ...target, repoPath: alias });
  expect(queue.readComposerSend('queue-aliased')?.status).toBe('held');
  expect(queue.cancelComposerSend(target, 'queue-aliased')).toBe(true);
});

it('holds an unavailable checkout without blocking a healthy chat or preventing cancellation', async () => {
  const missing = join(root, 'temporary-repo'); mkdirSync(missing);
  const offline = { repoPath: missing, threadId: 'thoughts-offline' };
  writeFileSync(join(root, 'chat-history', 'thoughts-offline.json'), JSON.stringify({ repoPath: missing, messages: [] }));
  queue.enqueueComposerSend({ ...offline, id: 'queue-offline', intent: 'send-next', payload: base });
  rmSync(missing, { recursive: true });
  await enqueue('queue-healthy'); const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-healthy')?.status).toBe('applied'));
  expect(queue.readComposerSend('queue-offline')?.status).toBe('held');
  expect(queue.cancelComposerSend(offline, 'queue-offline')).toBe(true);
});
it('holds an asynchronous provider error without throwing out of its process event callback', async () => {
  mocks.send.mockImplementationOnce(async (_repo, _message, emit) => new Promise<void>(resolve => {
    setImmediate(() => {
      emit({ type: 'error', error: 'Provider process exited.' });
      emit({ type: 'done', sessionId: null, cost: null }); resolve();
    });
  }));
  await enqueue('queue-provider-error'); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-provider-error')?.status).toBe('held'));
  expect(queue.readComposerSend('queue-provider-error')?.reason).toContain('Provider process exited');
  expect(active.size).toBe(0);
});
it('routes Stop from a symlink-backed chat to the admitted queued provider controller', async () => {
  const alias = join(root, 'stop-alias'); symlinkSync(repo, alias);
  writeFileSync(historyPath, JSON.stringify({ repoPath: alias, backend: 'codex', messages: [] }));
  const controllers = new Map<string, AbortController>();
  mocks.send.mockImplementationOnce(async (_repo, _message, emit, options) => new Promise<void>(resolve => {
    options.signal!.addEventListener('abort', () => { emit({ type: 'done', sessionId: null, cost: null }); resolve(); }, { once: true });
  }));
  await enqueue('queue-alias-stop');
  createChatContinuationHeartbeat({ ...hooks, registerAbort: (path, origin, controller) => {
    const key = orchestratorContinuationAbortKey(path, origin.backend, '', origin.threadId);
    controllers.set(key, controller); return () => { controllers.delete(key); };
  } })();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.calls[0][0]).toBe(alias);
  const controller = controllers.get(orchestratorContinuationAbortKey(alias, 'codex', '', threadId));
  expect(controller).toBeDefined();
  queue.holdComposerSends({ ...target, repoPath: alias }); controller!.abort();
  await vi.waitFor(() => expect(controllers.size).toBe(0));
  expect(queue.readComposerSend('queue-alias-stop')?.status).toBe('held');
});
