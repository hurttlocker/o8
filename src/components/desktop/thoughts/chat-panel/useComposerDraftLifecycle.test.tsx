// @vitest-environment jsdom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useComposerDraftLifecycle } from './useComposerDraftLifecycle';
import type { ContextualConversation } from './contextual-turn';
function Harness({ open, injected, contextual }: { open: boolean; injected?: { id: string; text: string }; contextual?: boolean }) {
  const [input, setInput] = useState(contextual ? 'My unsent reply' : '');
  const [, setPreEnhanceInput] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversation: ContextualConversation | undefined = contextual ? { requestContext: 'Thread metadata' } : undefined;
  useComposerDraftLifecycle({ open, input, draftInjection: injected, contextualConversation: conversation, setInput, setPreEnhanceInput, inputRef });
  return <textarea ref={inputRef} value={input} readOnly />;
}
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it('consumes each injected draft once and accepts a new draft that arrived while hidden', async () => {
  const injected = { id: 'draft-1', text: 'First request' };
  await act(async () => root.render(createElement(Harness, { open: true, injected })));
  expect(host.querySelector('textarea')!.value.match(/First request/g)).toHaveLength(1);
  await act(async () => root.render(createElement(Harness, { open: false, injected })));
  await act(async () => root.render(createElement(Harness, { open: true, injected: { id: 'draft-2', text: 'Second request' } })));
  expect(host.querySelector('textarea')!.value.match(/Second request/g)).toHaveLength(1);
});
it('preserves the reply draft when a contextual surface is closed and reopened', async () => {
  await act(async () => root.render(createElement(Harness, { open: true, contextual: true })));
  await act(async () => root.render(createElement(Harness, { open: false, contextual: true })));
  await act(async () => root.render(createElement(Harness, { open: true, contextual: true })));
  expect(host.querySelector('textarea')!.value).toBe('My unsent reply');
});
