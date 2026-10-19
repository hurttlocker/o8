import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import sharp from 'sharp';
import { submitVisualInstruction, VISUAL_REQUEST_MARKER, VisualInstructionDeliveryError } from '@/lib/composer/visual-instruction-send';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
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
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-visual-exec-')));
const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'chat-history'));
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'queue.db'));
const threadId = 'thoughts-queued-execution'; const target = { repoPath: repo, threadId };
const historyPath = join(root, 'chat-history', `${threadId}.json`);
const { getSqlite, closeDb } = await import('@/lib/db');
const queue = await import('@/lib/orchestrator/composer-queue');
const { POST } = await import('@/app/api/orchestrator/composer-queue/route');
const { createChatContinuationHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
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
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue'); mocks.send.mockClear(); mocks.beforeProject = null; busy = false;
  writeFileSync(historyPath, JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function visualDraft(): Promise<VisualInstructionDraft> {
  // Real raster bytes, a conspicuous red mark over a light background.
  const png = await sharp({ create: { width: 80, height: 60, channels: 4, background: 'white' } })
    .composite([{ input: Buffer.from('<svg width="80" height="60"><path d="M10 30 L70 30" stroke="red" stroke-width="6"/></svg>') }]).png().toBuffer();
  return { principal: 'account-a', status: 'draft', template: { ...base, wireMessage: `Captured project context\n${VISUAL_REQUEST_MARKER}` },
    request: { version: 1, id: 'visual-real-1', createdAt: '2026-10-19T12:00:00.000Z', target, utterance: 'Keep $& and $` literally. Change the red line.',
      frames: Array.from({ length: 4 }, (_, index) => ({ id: `frame-${index}`, atMs: index * 1_000, width: 80, height: 60,
        transcript: `Frame ${index + 1} original words.`, image: { name: `marked-${index}.png`, dataUri: `data:image/png;base64,${png.toString('base64')}` },
        strokes: [{ points: [{ x: 0.125, y: 0.5, tMs: 0 }, { x: 0.875, y: 0.5, tMs: 150 }] }], pins: [] })),
      clarification: { path: 'intent.target', question: 'Which line?', value: 'red line' } } };
}
const routeTransport: typeof fetch = async (_url, init) => POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
  ...init, signal: init?.signal ?? undefined, headers: { host: 'localhost', 'Content-Type': 'application/json' },
}));
it('persists four marked frames from the real visual submit entry and delivers once to the captured chat after reconnect', async () => {
  const draft = await visualDraft();
  const item = await submitVisualInstruction(draft, routeTransport);
  expect(item).toMatchObject({ id: 'visual-visual-real-1', threadId, status: 'queued' });
  closeDb();
  expect(queue.readComposerSend(item.id)?.payload).toMatchObject({ text: draft.request.utterance,
    images: draft.request.frames.map(frame => frame.image), routing: base.routing });
  busy = true; const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).not.toHaveBeenCalled();
  busy = false; heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend(item.id)?.status).toBe('applied'));
  const [_repo, wire, _emit, options] = mocks.send.mock.calls[0];
  expect(_repo).toBe(repo); expect(wire).toContain(draft.request.utterance);
  expect(wire).toContain('Frame 4 original words.'); expect(wire).toContain('intent.target');
  expect(options).toMatchObject({ threadId, permissionMode: 'plan', model: 'selected-model', attachments: draft.request.frames.map(frame => frame.image) });
  const delivered = options.attachments![0];
  const pixels = await sharp(Buffer.from(delivered.dataUri.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
  const middle = (30 * pixels.info.width + 40) * pixels.info.channels;
  expect(pixels.data[middle]).toBe(255); expect(pixels.data[middle + 1]).toBe(0); expect(pixels.data[middle + 2]).toBe(0);
  expect(readPersistedLlmChat(threadId)?.history.messages.find(row => row.role === 'user')).toMatchObject({ content: draft.request.utterance });
  closeDb(); createChatContinuationHeartbeat(hooks)(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it('reconciles a lost response with its original ID without duplicating the accepted turn', async () => {
  const draft = await visualDraft();
  await expect(submitVisualInstruction(draft, async (url, init) => { await routeTransport(url, init); throw new Error('Connection lost after acceptance'); })).rejects.toThrow('Connection lost');
  closeDb(); const accepted = await submitVisualInstruction(draft, routeTransport);
  expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
  createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend(accepted.id)?.status).toBe('applied'));
  await submitVisualInstruction(draft, routeTransport); createChatContinuationHeartbeat(hooks)();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).toHaveBeenCalledTimes(1);
});
it('retains editable evidence for a known rejection and refuses mismatched saved chat identity', async () => {
  const draft = await visualDraft(); draft.request.target = { ...target, repoPath: join(root, 'wrong-repo') };
  await expect(submitVisualInstruction(draft, routeTransport)).rejects.toMatchObject({ name: 'VisualInstructionDeliveryError', uncertain: false });
  expect(queue.listQueuedComposerSends(target)).toHaveLength(0);
  const original = await visualDraft(); original.request.utterance = 'x'.repeat(16_001);
  const send = vi.fn(routeTransport);
  await expect(submitVisualInstruction(original, send)).rejects.toBeInstanceOf(VisualInstructionDeliveryError);
  expect(send).not.toHaveBeenCalled(); expect(original.request.frames).toHaveLength(4);
});
