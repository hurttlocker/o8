// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetWorkspaceSteerQueueForTests, useWorkspaceSteerQueue, type WorkspaceSendOutcome } from './workspace-chat-queue';
let host: HTMLDivElement; let root: Root; let queue: ReturnType<typeof useWorkspaceSteerQueue>;
let available = false; let scope = 'parent'; const send = vi.fn();
function Harness() { const current = useWorkspaceSteerQueue(scope, available, send); useEffect(() => { queue = current; }, [current]); return createElement('div', null, current.items.map(item => `${item.text}:${item.status}`).join('|')); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); available = false; scope = 'parent'; send.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetWorkspaceSteerQueueForTests(); });
const render = () => act(async () => root.render(createElement(Harness)));
it('retains the exact intent until acknowledged and protects it from concurrent edit/delete', async () => {
  let settle!: (value: WorkspaceSendOutcome) => void;
  send.mockImplementation(() => new Promise<WorkspaceSendOutcome>(resolve => { settle = resolve; }));
  await render(); await act(async () => { queue.enqueue('first'); queue.enqueue('second'); });
  available = true; await render();
  const id = queue.items[0].id;
  await act(async () => { queue.remove(id); queue.edit(id, 'changed'); queue.promote(queue.items[1].id); });
  expect(queue.items.map(item => item.text)).toEqual(['first', 'second']); expect(send).toHaveBeenCalledTimes(1);
  available = false; await render(); await act(async () => settle('accepted'));
  expect(queue.items.map(item => item.text)).toEqual(['second']);
});
it('pauses a rejected delivery, retries only on explicit resume, and preserves later messages', async () => {
  send.mockResolvedValueOnce('failed').mockResolvedValue('accepted');
  await render(); await act(async () => { queue.enqueue('retry'); queue.enqueue('later'); }); available = true; await render();
  expect(queue.items).toHaveLength(2); expect(queue.paused).toBe(true); expect(send).toHaveBeenCalledTimes(1);
  const previous = send.mock.calls[0][0].mutationId;
  await act(async () => queue.resume());
  expect(send.mock.calls[1][0].mutationId).not.toBe(previous); expect(queue.items).toHaveLength(0);
});
it('restores a cold queue paused and never replays an uncertain delivery automatically', async () => {
  send.mockResolvedValue('unconfirmed'); await render(); await act(async () => queue.enqueue('check delivery'));
  available = true; await render(); expect(queue.items[0].status).toBe('unconfirmed');
  const id = queue.items[0].mutationId;
  await act(async () => root.render(null)); resetWorkspaceSteerQueueForTests(false); await render();
  await act(async () => queue.resume()); expect(send).toHaveBeenCalledTimes(1);
  expect(queue.paused).toBe(true); expect(queue.items[0].mutationId).toBe(id); expect(queue.notice).toContain('Check the transcript');
});
it('keeps queued work isolated when a tab rebinds from parent to child', async () => {
  await render(); await act(async () => queue.enqueue('parent work')); scope = 'child'; await render();
  expect(queue.items).toHaveLength(0); await act(async () => queue.enqueue('child work'));
  scope = 'parent'; await render(); expect(queue.items.map(item => item.text)).toEqual(['parent work']);
  expect(queue.paused).toBe(true); expect(send).not.toHaveBeenCalled();
});
