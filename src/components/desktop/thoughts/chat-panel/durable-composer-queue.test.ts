/** @vitest-environment jsdom */
/* eslint-disable react-hooks/refs -- test harness owns its draft and imperative controller */
import { act, createElement, createRef, forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeComposerServiceTier } from '../composer-selector/service-tier-store';
import type { ComposerMode } from '../composer-mode';
import type { ComposerQueuePayload, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { useDefaultComposerSendBuffer } from './useDefaultComposerSendBuffer';
import { useBufferedOrchestratorSend } from './useBufferedOrchestratorSend';
import { managedVoiceFollowup } from './managed-voice-followup';
import { ComposerArea } from './ComposerArea';
import { ComposerSendBufferStatus } from './ComposerSendBufferStatus';

const { ws } = vi.hoisted(() => ({ ws: { options: null as null | { onRealtimeEvent: (event: unknown) => void } } }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: (_: unknown, options: typeof ws.options) => { ws.options = options; } }));
vi.mock('../InputButtons', () => ({ InputButtons: () => null, RepoTargetChip: () => null }));
vi.mock('./SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('./ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('../../composer-center-registry', () => ({ registerComposerCenter: () => () => undefined }));
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));

const send = vi.fn(() => null);
const image = { name: 'proof.png', dataUri: 'data:image/png;base64,YQ==', mimeType: 'image/png' };
type Controller = { setDraft: (text: string) => void; enqueueVoice: () => Promise<void>; cancelVoice: () => Promise<string> };
const control = createRef<Controller>();
const Harness = forwardRef<Controller, { threadId: string; model?: string; mode?: ComposerMode; busy?: boolean; backend?: 'codex' | 'pi' }>(function Harness({ threadId, model = 'original-model', mode = 'solo', busy = true, backend = 'codex' }, ref) {
  const [input, setInput] = useState('Queue this message');
  const [images, setImages] = useState([image]);
  const latestInputRef = useRef(input); const inputRef = useRef<HTMLTextAreaElement>(null);
  const { dispatch, capture } = useBufferedOrchestratorSend({ active: true, backend, model, mode, solo: false,
    effort: 'low', permissionMode: 'plan', collide: false, projectId: 'original-project', context: 'Original context', send });
  const result = useDefaultComposerSendBuffer({ active: true, backend, busy, threadId, repoPath: '/repo', attachedImages: images,
    latestInputRef, inputRef, setInput, addAttachedImage: entry => setImages(previous => [...previous, entry]), clearAttachments: () => setImages([]),
    dispatch, captureQueuedSend: capture, interrupt: vi.fn(), undoSend: vi.fn(), shouldBypass: () => false, sendUnbuffered: vi.fn() });
  const voice = managedVoiceFollowup(result.durable, text => capture(text, []));
  useImperativeHandle(ref, () => ({ setDraft: text => { latestInputRef.current = text; setInput(text); },
    enqueueVoice: () => voice.enqueue('voice-test', 'Do the follow-up', 'original-task'), cancelVoice: voice.cancel }));
  return createElement(ComposerArea, { input, inputLabel: 'Queue test composer', onInputChange: text => { latestInputRef.current = text; setInput(text); },
    activeComposer: true, isOrchestratorMode: true, displayWaiting: busy, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true,
    thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance: vi.fn(), onUndoEnhance: vi.fn(),
    onSubmit: result.handleSend, onSteer: result.handleSteer, queueSaving: result.saving, onSlashCommand: vi.fn(), modelLabel: model,
    effort: 'low', onEffortChange: vi.fn(), adaptiveEnabled: false, displayMessagesCount: 0, hasAssistantActivity: false, attachedImages: images,
    sendBufferStatus: createElement(ComposerSendBufferStatus, { attachmentError: result.attachmentError, queued: result.sendBuffer.queued,
      undoArmed: false, undoSequence: 0, onUndo: vi.fn(), onCancelQueued: result.sendBuffer.cancelQueued }),
  });
});
let host: HTMLDivElement; let root: Root; let rows: QueuedComposerSendRecord[]; let posts: Array<{ id: string; threadId: string; payload: ComposerQueuePayload }>;
let failAfterPersist = false;
let delayPost: (() => Promise<void>) | null = null;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  rows = []; posts = []; failAfterPersist = false; delayPost = null; send.mockClear(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = (data: unknown) => ({ ok: true, json: async () => data });
    if (!url.startsWith('/api/orchestrator/composer-queue')) return response({});
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string); posts.push(body); await delayPost?.();
      let item = rows.find(row => row.id === body.id);
      if (!item) { item = { ...body, sequence: rows.length + 1, status: 'queued', reason: null, createdAt: 1, updatedAt: 1, admittedAt: null }; rows.push(item!); }
      if (failAfterPersist) { failAfterPersist = false; throw new Error('Response lost. Retry the same draft.'); }
      return response({ item });
    }
    if (init?.method === 'DELETE') { const body = JSON.parse(init.body as string); rows = rows.filter(row => row.id !== body.id); return response({ ok: true }); }
    const thread = new URL(url, 'http://localhost').searchParams.get('threadId');
    return response({ items: rows.filter(row => row.threadId === thread && ['queued', 'dispatching', 'held'].includes(row.status)).map(row => structuredClone(row)) });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(threadId = 'thoughts-one', model = 'original-model', mode: ComposerMode = 'solo', busy = true, backend: 'codex' | 'pi' = 'codex') {
  await act(async () => root.render(createElement(Harness, { ref: control, threadId, model, mode, busy, backend })));
}
async function enter(metaKey = false) {
  await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey, bubbles: true, cancelable: true })));
}

describe('durable Send next through the normal composer', () => {
  it('keeps the original destination, attachment and routing across navigation/reload and removes a cancelled item durably', async () => {
    writeComposerServiceTier('codex', 'original-model', 'priority');
    await render(); await enter();
    writeComposerServiceTier('codex', 'original-model', 'default');
    expect(send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoPath: '/repo', threadId: 'thoughts-one', payload: { text: 'Queue this message', images: [{ name: image.name, dataUri: image.dataUri }],
      routing: { backend: 'codex', model: 'original-model', effort: 'low', serviceTier: 'priority', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', projectId: 'original-project' } } });
    expect(rows[0].payload.wireMessage).toContain('Original context');
    await render('thoughts-two', 'new-model', 'fast');
    expect(host.querySelector('[role="list"]')).toBeNull();
    await act(async () => control.current!.setDraft('Another chat'));
    await enter();
    expect(rows.map(row => row.threadId)).toEqual(['thoughts-one', 'thoughts-two']);
    expect(rows[0].payload.routing.model).toBe('original-model');
    expect(rows[0].payload.routing.serviceTier).toBe('priority');
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'changed-model', 'fast');
    expect(host.querySelector('[role="list"]')?.textContent).toContain('Queue this message');
    expect(host.querySelector('[role="list"]')?.textContent).not.toContain('Another chat');
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one');
    expect(host.querySelector('[role="list"]')?.textContent).toContain('1 image');
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.click());
    expect(rows.map(row => row.threadId)).toEqual(['thoughts-two']);
    await act(async () => root.unmount()); root = createRoot(host); await render('thoughts-one');
    expect(host.querySelector('[role="list"]')).toBeNull();
  });

  it('keeps a new idle submission behind previously queued intent after returning to the chat', async () => {
    await render(); await enter();
    await act(async () => control.current!.setDraft('Follow the queued message'));
    await render('thoughts-one', 'new-model', 'fast', false);
    await enter();
    expect(send).not.toHaveBeenCalled();
    expect(rows.map(row => row.payload.text)).toEqual(['Queue this message', 'Follow the queued message']);
    expect(rows.map(row => row.payload.routing.model)).toEqual(['original-model', 'new-model']);
  });

  it('keeps the draft intact for unavailable steering and creates no held FIFO blocker', async () => {
    await render();
    const steer = [...host.querySelectorAll('button')].find(button => button.textContent === 'Steer now')!;
    expect(steer.disabled).toBe(true);
    await enter(true);
    expect(posts).toHaveLength(0);
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Live steering is unavailable');
    await enter();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('reuses the same mutation identity after an uncertain response instead of duplicating the message', async () => {
    await render(); failAfterPersist = true; await enter();
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response lost');
    await enter();
    expect(posts).toHaveLength(2);
    expect(posts[0].id).toBe(posts[1].id);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('reconciles the same uncertain send after a full composer reload, even after it has left the visible queue', async () => {
    await render(); failAfterPersist = true; await enter();
    const original = structuredClone(posts[0]);
    rows[0] = { ...rows[0], status: 'applied', admittedAt: 10 };
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'changed-model', 'fast', false);
    await enter();
    expect(send).not.toHaveBeenCalled();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(original);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('retains uncertain identities independently across chats and routing changes', async () => {
    await render(); failAfterPersist = true; await enter();
    await render('thoughts-two');
    await act(async () => control.current!.setDraft('Another queued message'));
    await enter();
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'changed-model', 'fast');
    await act(async () => control.current!.setDraft('Queue this message'));
    await enter();
    expect(posts[2].id).toBe(posts[0].id);
    expect(posts[2].payload).toEqual(posts[0].payload);
    expect(rows).toHaveLength(2);
  });

  it('bounds a stalled save, retains the draft and retries only on request with its original identity', async () => {
    await render(); vi.useFakeTimers();
    const normal = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string));
        return new Promise<Response>(() => {});
      }
      return normal(url, init);
    }));
    await enter();
    expect(host.textContent).toContain('Saving message');
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(host.textContent).not.toContain('Saving message');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    expect(posts).toHaveLength(1);
    vi.stubGlobal('fetch', normal);
    await enter();
    expect(posts[1].id).toBe(posts[0].id);
    expect(rows).toHaveLength(1);
  });

  it('bounds a stalled cancellation and allows an explicit retry without hiding the saved message', async () => {
    await render(); await enter(); vi.useFakeTimers();
    const normal = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Promise<Response>(() => {}) : normal(url, init)));
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
    expect(host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.disabled).toBe(false);
    expect(rows).toHaveLength(1);
    vi.stubGlobal('fetch', normal);
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.click());
    expect(rows).toHaveLength(0);
  });

  it('retains recovery when a success arrives after its original composer unmounts', async () => {
    await render();
    const normal = globalThis.fetch; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const response = await normal(url, init);
      if (init?.method === 'POST') await gate;
      return response;
    }));
    await enter(); expect(rows).toHaveLength(1);
    const original = structuredClone(posts[0]);
    rows[0] = { ...rows[0], status: 'applied', admittedAt: 1 };
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'later-model', 'solo', false);
    await act(async () => release());
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    vi.stubGlobal('fetch', normal); await enter();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(original);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('reconciles a pending image send using its saved backend after switching to a backend without image support', async () => {
    await render(); failAfterPersist = true; await enter();
    const original = structuredClone(posts[0]);
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', '', 'solo', false, 'pi');
    await enter();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(original);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('refuses before posting if recovery cannot be saved, preserving text and attachment', async () => {
    await render();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    try {
      await enter();
      expect(posts).toHaveLength(0);
      expect(host.querySelector('textarea')!.value).toBe('Queue this message');
      expect(host.textContent).toContain('proof.png');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('recovery could not be saved');
    } finally { write.mockRestore(); }
  });

  it('allows a deliberate identical message after the previous submission was confirmed', async () => {
    await render(); await enter();
    await act(async () => root.unmount()); root = createRoot(host);
    await render(); await enter();
    expect(posts).toHaveLength(2);
    expect(posts[1].id).not.toBe(posts[0].id);
    expect(rows).toHaveLength(2);
  });

  it('shows preparation and held outcomes without claiming steering was applied, and only disables removal after admission', async () => {
    await render(); await enter();
    rows[0] = { ...rows[0], status: 'dispatching', admittedAt: 10 };
    await act(async () => ws.options!.onRealtimeEvent({ channel: 'mutation', data: { mutation: { action: 'composer-queue', surfaceId: 'thoughts-one' } } }));
    expect(host.querySelector('[role="list"]')?.textContent).toContain('Sending');
    expect(host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.disabled).toBe(true);
    rows[0] = { ...rows[0], status: 'held', reason: 'Delivery interrupted. Inspect the chat.' };
    await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
    expect(host.querySelector('[role="list"]')?.textContent).toContain('Needs attention: Delivery interrupted. Inspect the chat.');
    expect(host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.disabled).toBe(false);
    expect(host.textContent).not.toMatch(/Steering applied|Steer applied/);
  });
});

it.each([false, true])('withdraws an in-flight voice save durably even when its response is lost: %s', async lostResponse => {
  await render();
  let release!: () => void;
  delayPost = () => new Promise<void>(resolve => { release = resolve; });
  failAfterPersist = lostResponse;
  let saving!: Promise<void>; let canceling!: Promise<string>;
  await act(async () => { saving = control.current!.enqueueVoice(); void saving.catch(() => {}); });
  expect(posts).toHaveLength(1);
  await act(async () => { canceling = control.current!.cancelVoice(); });
  // Navigation cannot send withdrawal to whichever chat becomes selected next.
  await render('thoughts-two');
  let outcome = '';
  await act(async () => { release(); await saving.catch(() => {}); outcome = await canceling; });
  expect(outcome).toContain('canceled before submission');
  expect(rows).toEqual([]);
  await render('thoughts-one');
  expect(host.querySelector('[role="list"]')).toBeNull();
});
