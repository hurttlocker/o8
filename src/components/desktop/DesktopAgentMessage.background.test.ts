// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopAgentMessage } from './DesktopAgentMessage';

let host: HTMLDivElement;
let root: Root;
const text = 'A streamed answer with enough words to require several animation frames. '.repeat(20);
const entry = { id: 'background-reveal', role: 'assistant' as const, text };
async function render(animateStreaming: boolean) {
  await act(async () => root.render(createElement(DesktopAgentMessage, { entry, isStreaming: true, animateStreaming })));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
it('shows the complete hidden stream batch without scheduling a typewriter reveal', async () => {
  const frame = vi.spyOn(window, 'requestAnimationFrame');
  await render(false);
  expect(host.textContent).toContain(text);
  expect(frame).not.toHaveBeenCalled();
  frame.mockRestore();
});
it('stops an existing visible reveal when its tab becomes hidden', async () => {
  await render(true);
  await act(async () => vi.advanceTimersByTime(20));
  expect(host.textContent).not.toContain(text);
  await render(false);
  expect(host.textContent).toContain(text);
  const settled = host.innerHTML;
  await act(async () => vi.advanceTimersByTime(1000));
  expect(host.innerHTML).toBe(settled);
});
