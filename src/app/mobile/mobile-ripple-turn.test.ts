// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from './mobile-approvals-shared';
import { createMobileChatModel } from './mobile-assistant-chat-model';
import { rememberRippleResolution } from '@/lib/mobile/ripple-client';
import type { RippleChoiceResolution } from '@/lib/mobile/ripple-contract';

const utterance = 'fix the target';
const resolution: RippleChoiceResolution = {
  kind: 'choice', id: 'resolution-one', question: 'Which target?',
  options: [{ label: 'Client', value: 'client' }, { label: 'Server', value: 'server' }],
  aodlPath: 'intent.target',
};
const model: ModelOption = { id: 'fixture-model', label: 'Fixture', provider: 'openai', description: 'Fixture', backend: 'api' };

function confirm(draftId: string, threadId = 'chat-one', repoPath = '/fixture/repo') {
  rememberRippleResolution({
    utterance, resolution, choice: resolution.options[0], resolutionMs: 20,
    scope: { draftId, threadId, repoPath },
  });
}

async function send(draftId: string | undefined, messageId: string, threadId = 'chat-one', repoPath = '/fixture/repo') {
  let request: { messages: Array<{ role: string; content: string }> } | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response('data: {"type":"content","text":"done"}\n\ndata: {"type":"done"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }));
  const adapter = createMobileChatModel(model, repoPath, undefined, threadId);
  const stream = adapter.run({
    messages: [{ id: messageId, role: 'user', content: [{ type: 'text', text: utterance }] }],
    runConfig: { custom: { rippleDraftId: draftId } }, abortSignal: new AbortController().signal,
  } as never) as AsyncGenerator<unknown>;
  for await (const _chunk of stream) { /* Consume the real model entry point. */ }
  return request!.messages.some((message) => message.role === 'system' && message.content.includes('intent.target'));
}

describe('Ripple confirmation reaches only its submitted turn', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear(); });

  it('consumes a confirmed draft once and binds its persisted receipt to the message ID', async () => {
    const draftId = crypto.randomUUID();
    confirm(draftId);
    expect(await send(draftId, 'message-one')).toBe(true);
    expect(await send(draftId, 'message-two')).toBe(false);
    const episodes = JSON.parse(window.localStorage.getItem('o8.ripple.episodes.v1')!);
    expect(episodes.at(-1)).toMatchObject({ scope: { draftId, threadId: 'chat-one', repoPath: '/fixture/repo' }, messageId: 'message-one' });
  });

  it.each([
    ['chat-two', '/fixture/repo'], ['chat-one', '/fixture/other-repo'],
  ])('refuses a confirmation from another chat or repository (%s, %s)', async (threadId, repoPath) => {
    const draftId = crypto.randomUUID();
    confirm(draftId);
    expect(await send(draftId, 'wrong-scope', threadId, repoPath)).toBe(false);
    expect(await send(draftId, 'correct-scope')).toBe(true);
  });

  it('refuses unconfirmed and expired submissions even when the words match', async () => {
    const draftId = crypto.randomUUID();
    confirm(draftId);
    expect(await send(undefined, 'unconfirmed')).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    expect(await send(draftId, 'expired')).toBe(false);
  });
});
