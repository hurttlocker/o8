/** @vitest-environment jsdom */
/* eslint-disable react-hooks/refs -- fixture refs are passed to the production composer registration */
import { act, createElement, useRef, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DictationHost } from './DictationHost';
import { ComposerDictationContext } from './ComposerDictation';
import { useAgentVoiceMode } from '../thoughts/chat-panel/useAgentVoiceMode';
import { ManagedLiveButton } from '../thoughts/chat-panel/ManagedLiveButton';
import { MicButton } from '../thoughts/MicButton';
import { VisualComposerArea } from '../visual-instructions/VisualComposerArea';
import { ManagedChatVoiceEntry } from '../thoughts/chat-panel/ManagedChatVoiceEntry';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { visualLiveState } from '@/lib/composer/visual-live-context';

const fixture = vi.hoisted(() => ({ native: false, nativeStarts: 0, browser: null as string | null,
  closed: false, invoke: vi.fn(), listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  draft: null as VisualInstructionDraft | null, drafts: new Set<() => void>() }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: 'fixture' }, isLoaded: true }) }));
vi.mock('@/lib/composer/visual-draft-store', () => ({
  readVisualDraft: (principal: string, target: { threadId: string }) => fixture.draft?.principal === principal && fixture.draft.request.target.threadId === target.threadId ? fixture.draft : null,
  subscribeVisualDrafts: (listener: () => void) => { fixture.drafts.add(listener); return () => fixture.drafts.delete(listener); },
  restoreVisualDraft: async () => {}, removeVisualDraft: async () => {},
  saveVisualDraft: async (draft: VisualInstructionDraft) => { fixture.draft = draft; fixture.drafts.forEach(listener => listener()); },
}));
vi.mock('./DictationPill', () => ({ DictationPill: () => null }));
vi.mock('./useSymonEditBridge', () => ({ useSymonEditBridge: () => {} }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => true, isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@/lib/tauri/events', () => ({ subscribeTauriEvent: (name: string, receive: (event: { payload: unknown }) => void) => {
  const listeners = fixture.listeners.get(name) ?? new Set(); fixture.listeners.set(name, listeners); listeners.add(receive);
  return () => listeners.delete(receive);
} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, receive: (event: { payload: unknown }) => void) => {
  const listeners = fixture.listeners.get(name) ?? new Set(); fixture.listeners.set(name, listeners); listeners.add(receive);
  return () => listeners.delete(receive);
} }));
vi.mock('@/lib/tts/dictation-barge-in', () => ({ stopPlaybackForDictation: () => false }));
vi.mock('@/lib/tts/engine', () => ({ ttsEngine: { state: {}, stop: vi.fn(), play: vi.fn() } }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
class Peer {
  localDescription = { sdp: 'fixture-offer' }; connectionState = 'connected';
  ontrack = null; onconnectionstatechange = null;
  addTrack() {} createDataChannel() {} close() {}
  createOffer = async () => this.localDescription;
  setLocalDescription = async () => {}; setRemoteDescription = async () => {};
}
class AudioFixture { srcObject = null; play = async () => {}; pause() {} }
class AudioContextFixture {
  close = async () => {};
  createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }; }
  createMediaStreamSource() { return { connect() {} }; }
}
let root: Root; let node: HTMLDivElement;
const media = vi.fn(); const stopped = vi.fn(); const providerStart = vi.fn();
const stream = () => ({ getTracks: () => [{ stop: stopped }] });
const routing = { backend: 'codex', model: 'selected', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } as const;
const visualTarget = (thread: string) => ({ repoPath: '/project', threadId: `thoughts-${thread}` });
function VisualChat({ thread = 'a' }: { thread?: string }) {
  const chatRoot = useRef<HTMLDivElement>(null); const target = visualTarget(thread);
  const capture = (text: string) => ({ text, wireMessage: text, images: [], routing });
  const queue = { items: [], ready: true, error: null } as unknown as ComponentProps<typeof ManagedChatVoiceEntry>['queue'];
  return createElement('div', { ref: chatRoot, 'data-voice-chat-root': true }, createElement(VisualComposerArea, {
    visual: { active: true, target, label: 'Current chat', capture }, activeComposer: true, dictationScopeKey: thread,
    showBrain: false, input: 'Ordinary draft', onInputChange: () => {}, isOrchestratorMode: true,
    displayWaiting: false, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true, thoughtsBodyBackground: 'var(--t-chat-surface-bg)',
    enhancing: false, preEnhanceInput: null, onEnhance: () => {}, onUndoEnhance: () => {}, onSubmit: () => {}, onSlashCommand: () => {},
    modelLabel: 'Codex', effort: 'low', onEffortChange: () => {}, adaptiveEnabled: false, displayMessagesCount: 1, hasAssistantActivity: false,
    voiceControl: createElement('div', { 'data-testid': 'visual-live' }, createElement(ManagedChatVoiceEntry, {
      chatRoot, identity: [thread, 'selected'], visualTarget: target, queue, capture,
      messages: [], terminals: {}, busy: false, send: () => null, interrupt: () => {},
    })),
  }));
}
function Composer() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { dictationId } = useAgentVoiceMode({ active: true, dictationOnly: true, busy: false, composerNodeRef: ref,
    fillInput: () => {}, messages: [], sendNow: () => false, surfaceKey: 'current-chat' });
  return createElement(ComposerDictationContext.Provider, { value: dictationId }, createElement('div', { 'data-testid': 'dictation' },
    createElement('textarea', { ref }), createElement(MicButton)));
}
const click = async (id: string) => { await act(async () => { node.querySelector<HTMLButtonElement>(`[data-testid="${id}"] button`)!.click(); }); };
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.clearAllMocks(); fixture.native = false; fixture.browser = null; fixture.closed = false; fixture.nativeStarts = 0; fixture.listeners.clear();
  fixture.draft = null; fixture.drafts.clear(); localStorage.clear();
  fixture.invoke.mockImplementation(async (command: string, args?: { owner?: string }) => {
    const busy = 'Another voice input is active. Finish it before starting another microphone.';
    if (command === 'voice_input_claim') { if (fixture.native || fixture.browser && fixture.browser !== args?.owner) throw new Error(busy); fixture.browser = args!.owner!; }
    if (command === 'voice_input_release' && fixture.browser === args?.owner) fixture.browser = null;
    if (command === 'o8_stt_start') { if (fixture.browser) throw new Error(busy); fixture.native = true; fixture.nativeStarts++; return 1; }
    if (command === 'o8_stt_stop' || command === 'o8_system_dictation_finish') fixture.native = false;
    if (command === 'managed_voice_presentation_epoch') return 1;
    return undefined;
  });
  media.mockResolvedValue(stream());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } });
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('Audio', AudioFixture); vi.stubGlobal('AudioContext', AudioContextFixture);
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (!init?.body) return Response.json({ enabled: true, entitled: true });
    const body = JSON.parse(String(init.body));
    if (body.action === 'start') { providerStart(); return Response.json({ id: 'voice-fixture', sdp: 'fixture-answer' }); }
    if (body.action === 'close') fixture.closed = true;
    return Response.json({ events: fixture.closed ? [{ cursor: 1, event: { type: 'session.closed', usage: { seconds: 1 } } }] : [] });
  }));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(DictationHost, null, createElement(Composer),
    createElement('div', { 'data-testid': 'live' }, createElement(ManagedLiveButton, {
      binding: 'current-chat', messages: [], terminals: {}, busy: false, send: () => null, interrupt: () => {},
    })))));
});
afterEach(async () => {
  await act(async () => { root.unmount(); await vi.advanceTimersByTimeAsync(300); });
  node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
it('refuses native composer capture before opening its engine when Live already owns input', async () => {
  await click('live'); expect(providerStart).toHaveBeenCalledOnce(); expect(media).toHaveBeenCalledOnce();
  await click('dictation');
  expect(fixture.nativeStarts).toBe(0); expect(fixture.browser).not.toBeNull(); expect(stopped).not.toHaveBeenCalled();
});
it('refuses Live before microphone/provider creation while native composer input is recording', async () => {
  await click('dictation'); expect(fixture.nativeStarts).toBe(1);
  await click('live');
  expect(media).not.toHaveBeenCalled(); expect(providerStart).not.toHaveBeenCalled(); expect(fixture.native).toBe(true);
  expect(node.textContent).toContain('Another voice input is active');
});
it('keeps a cancelled permission request reserved until the late stream is stopped', async () => {
  let grant!: (value: ReturnType<typeof stream>) => void;
  media.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  await click('live'); await click('live');
  await click('dictation'); expect(fixture.nativeStarts).toBe(0); expect(fixture.browser).not.toBeNull();
  await act(async () => { grant(stream()); await vi.advanceTimersByTimeAsync(2500); });
  expect(stopped).toHaveBeenCalledOnce(); expect(fixture.browser).toBeNull(); expect(providerStart).not.toHaveBeenCalled();
  await click('dictation'); expect(fixture.nativeStarts).toBe(1);
});
it('keeps the same Live transport through Show mode, close and resume, until an explicit voice stop', async () => {
  await act(async () => root.render(createElement(VisualChat)));
  await click('visual-live'); expect(providerStart).toHaveBeenCalledOnce();
  const scope = { principal: 'fixture', target: visualTarget('a'), routing };
  expect(visualLiveState(scope)).toBe('matching');
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Show with images"]')!.click(); await vi.advanceTimersByTimeAsync(300); });
  expect(fixture.closed).toBe(false); expect(stopped).not.toHaveBeenCalled(); expect(visualLiveState(scope)).toBe('matching');
  expect(node.querySelector('[aria-label="Capture screen"]')).not.toBeNull();
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close visual draft"]')!.click());
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Resume visual instruction"]')!.click());
  expect(providerStart).toHaveBeenCalledOnce(); expect(media).toHaveBeenCalledOnce(); expect(fixture.nativeStarts).toBe(0);
  await act(async () => { fixture.listeners.get('o8:managed-chat-voice-toggle')?.forEach(receive => receive({ payload: null })); await vi.advanceTimersByTimeAsync(300); });
  expect(fixture.closed).toBe(true); expect(stopped).toHaveBeenCalledOnce();
});
it('still closes the original Live owner when the chat changes from visual mode', async () => {
  await act(async () => root.render(createElement(VisualChat)));
  await click('visual-live');
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Show with images"]')!.click());
  expect(fixture.closed).toBe(false);
  await act(async () => root.render(createElement(VisualChat, { thread: 'b' })));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(fixture.closed).toBe(true); expect(stopped).toHaveBeenCalledOnce(); expect(providerStart).toHaveBeenCalledOnce();
  expect(visualLiveState({ principal: 'fixture', target: visualTarget('b'), routing })).toBe('none');
});
it.each(['keyboard Show', 'incoming visual draft'])('closes ordinary portaled menus on %s without closing Live', async entry => {
  await act(async () => root.render(createElement(VisualChat)));
  await click('visual-live');
  const trigger = node.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  expect(document.querySelector('[aria-label="Model and thinking"]')).not.toBeNull();
  await act(async () => {
    if (entry === 'keyboard Show') {
      const show = node.querySelector<HTMLButtonElement>('[aria-label="Show with images"]')!;
      show.focus(); show.click(); // Keyboard activation has no outside mousedown.
    } else {
      fixture.draft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '', images: [], routing },
        request: { version: 1, id: 'incoming-draft', createdAt: new Date().toISOString(), target: visualTarget('a'), utterance: '', frames: [] } };
      fixture.drafts.forEach(listener => listener());
    }
  });
  expect(document.querySelector('[data-composer-overlay]')).toBeNull();
  expect(fixture.closed).toBe(false); expect(stopped).not.toHaveBeenCalled();
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close visual draft"]')!.click());
  expect(document.querySelector('[data-composer-overlay]')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
