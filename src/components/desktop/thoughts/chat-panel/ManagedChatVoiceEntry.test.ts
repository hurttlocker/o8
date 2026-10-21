// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import type { ManagedLiveButton } from './ManagedLiveButton';
const store = vi.hoisted(() => ({ draft: null as VisualInstructionDraft | null, props: null as ComponentProps<typeof ManagedLiveButton> | null, hold: null as Promise<void> | null }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: 'fixture' }, isLoaded: true }) }));
vi.mock('./ManagedLiveButton', () => ({ ManagedLiveButton: (props: ComponentProps<typeof ManagedLiveButton>) => { store.props = props; return null; } }));
vi.mock('@/lib/composer/visual-draft-store', () => ({ readVisualDraft: () => store.draft,
  saveVisualDraft: async (draft: VisualInstructionDraft) => { store.draft = draft; await store.hold; } }));
const { ManagedChatVoiceEntry } = await import('./ManagedChatVoiceEntry');
const target = { repoPath: '/fixture', threadId: 'thoughts-fixture' };
let root: Root | null = null; let node: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); node?.remove(); root = null; node = null; vi.unstubAllGlobals(); store.hold = null; });
it.each(['unmount', 'voice closure'])('does not dispatch after %s while the visual draft is being persisted', async stop => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
  store.draft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '[o8-visual-instruction]', images: [], routing }, request: {
    version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), target, utterance: 'Keep this label.',
    frames: [{ id: 'frame-a', atMs: 0, transcript: '', width: 320, height: 280, strokes: [], pins: [], image: { name: 'actual.png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' } }],
  } };
  let release!: () => void; store.hold = new Promise(done => { release = done; });
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const queue = { items: [], ready: true, error: null } as unknown as ComponentProps<typeof ManagedChatVoiceEntry>['queue'];
  await act(async () => root!.render(createElement(ManagedChatVoiceEntry, { identity: ['selected-chat'], visualTarget: target, queue,
    capture: () => store.draft!.template, messages: [], terminals: {}, busy: false, send: () => null, interrupt: () => {} })));
  let live = true;
  const sending = store.props!.sendVisual!('Make it smaller.', undefined, () => live); void sending.catch(() => {});
  if (stop === 'unmount') { await act(async () => root!.unmount()); root = null; } else live = false;
  release();
  await expect(sending).rejects.toThrow('changed before dispatch');
  expect(transport).not.toHaveBeenCalled(); expect(store.draft?.status).toBe('draft');
});
