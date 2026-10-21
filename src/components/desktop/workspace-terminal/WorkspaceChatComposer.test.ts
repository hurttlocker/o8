// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { useWorkspaceChatPane } from './useWorkspaceChatPane';
import type { TerminalTab } from './types';
const attachments = vi.hoisted(() => ({ attachedImages: [{ name: 'image.png', mimeType: 'image/png', dataUri: 'data:image/png;base64,YQ==' }], attachedFiles: [], dragOver: false, dragHandlers: {}, clearAttachments: vi.fn(), consumeAttachedImages: vi.fn(), removeAttachedImage: vi.fn() }));
vi.mock('@/components/desktop/thoughts/chat-panel/useThoughtsComposerAttachments', () => ({ useThoughtsComposerAttachments: () => attachments }));
vi.mock('@/components/desktop/thoughts/chat-panel/useAgentVoiceMode', () => ({ useAgentVoiceMode: () => ({ enabled: false, setEnabled: vi.fn() }) }));
vi.mock('@/components/desktop/thoughts/InputButtons', () => ({ InputButtons: ({ onSubmit }: { onSubmit: () => void }) => createElement('button', { onClick: onSubmit }, 'Send fixture') }));
import { WorkspaceChatComposer } from './WorkspaceChatComposer';
let root: Root; let host: HTMLDivElement; let chat: ReturnType<typeof useWorkspaceChatPane>;
let repoPath: string | undefined = '/fixture/repo';
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); repoPath = '/fixture/repo';
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  chat = { draft: 'keep draft', queuedContextCards: [{ id: 'ctx', text: 'keep context', title: 'Context', meta: [] }], pendingSteers: [], messages: [], runtimeLabel: 'Fixture', selectedModel: { label: 'Default' }, composeRef: { current: null }, setDraft: vi.fn(), handleRemoveQueuedContext: vi.fn(), handleSend: vi.fn(), sendText: vi.fn().mockResolvedValue('accepted') } as unknown as ReturnType<typeof useWorkspaceChatPane>;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, relPath: 'o8-assets/image.png' }))));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(WorkspaceChatComposer, { active: true, chat, isLaneArchived: false, tab: { id: 'fixture', repo: repoPath ? { localPath: repoPath } : undefined } as TerminalTab, onSaveCheckpoint: vi.fn(), onRestoreLatestCheckpoint: vi.fn() })));
const submit = () => act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Send fixture')!.click());
it('uses the same attachment path for Enter and the send button, with a synchronous repeat guard', async () => {
  let finish!: (response: Response) => void; vi.mocked(fetch).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Send fixture')!.click(); });
  expect(fetch).toHaveBeenCalledTimes(1); expect(chat.handleSend).not.toHaveBeenCalled();
  await act(async () => finish(new Response(JSON.stringify({ ok: true, relPath: 'o8-assets/image.png' }))));
  expect(chat.sendText).toHaveBeenCalledExactlyOnceWith('keep context\n\nkeep draft\n\n![image.png](o8-assets/image.png)');
  expect(attachments.consumeAttachedImages).toHaveBeenCalledExactlyOnceWith(attachments.attachedImages);
});
it('keeps draft, context and images when upload or delivery fails and retries only on another click', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 })); await render(); await submit();
  expect(chat.sendText).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not upload');
  expect(chat.setDraft).not.toHaveBeenCalled(); expect(attachments.consumeAttachedImages).not.toHaveBeenCalled();
  vi.mocked(chat.sendText).mockResolvedValueOnce('failed'); await submit();
  expect(chat.handleRemoveQueuedContext).not.toHaveBeenCalled(); expect(attachments.consumeAttachedImages).not.toHaveBeenCalled();
  vi.mocked(chat.sendText).mockResolvedValue('accepted'); await submit();
  expect(fetch).toHaveBeenCalledTimes(2); expect(chat.handleRemoveQueuedContext).toHaveBeenCalledWith('ctx');
});
it('does not silently drop images from a chat without a repository', async () => {
  repoPath = undefined; await render(); await submit();
  expect(fetch).not.toHaveBeenCalled(); expect(chat.sendText).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Choose a repository');
});
it('does not start a message after the composer is dismissed during upload', async () => {
  let finish!: (response: Response) => void; vi.mocked(fetch).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(); await submit(); await act(async () => root.render(null));
  await act(async () => finish(new Response(JSON.stringify({ ok: true, relPath: 'o8-assets/image.png' }))));
  expect(chat.sendText).not.toHaveBeenCalled(); expect(chat.setDraft).not.toHaveBeenCalled(); expect(attachments.consumeAttachedImages).not.toHaveBeenCalled();
});
it('uploads into the new repository when a retained image is retried after retargeting', async () => {
  vi.mocked(chat.sendText).mockResolvedValue('failed'); await render(); await submit();
  repoPath = '/fixture/second'; await render(); vi.mocked(chat.sendText).mockResolvedValue('accepted'); await submit();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(fetch).mock.calls[1][0]).toContain(encodeURIComponent('/fixture/second'));
});
it('ignores a late upload from the old repository and prepares the new repository on retry', async () => {
  let finish!: (response: Response) => void; vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render(); await submit(); repoPath = '/fixture/retarget'; await render();
  await act(async () => finish(new Response(JSON.stringify({ ok: true, relPath: 'o8-assets/old.png' }))));
  expect(chat.sendText).not.toHaveBeenCalled(); await submit();
  expect(fetch).toHaveBeenCalledTimes(2); expect(vi.mocked(fetch).mock.calls[1][0]).toContain(encodeURIComponent('/fixture/retarget'));
});
