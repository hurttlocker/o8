// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
const observed = vi.hoisted(() => ({ rows: [] as Array<{ id: string; streaming: boolean; animate: boolean }> }));
// jsdom has no canvas text metrics; browser coverage uses the real measurement.
vi.mock('@/lib/pretext/hooks', () => ({ usePretextHeight: () => 24 }));
vi.mock('../../DesktopAgentMessage', async (original) => {
  const actual = await original<typeof import('../../DesktopAgentMessage')>();
  return { ...actual, DesktopAgentMessage: (props: Parameters<typeof actual.DesktopAgentMessage>[0]) => {
    observed.rows.push({ id: props.entry.id, streaming: props.isStreaming ?? false, animate: props.animateStreaming ?? true });
    return createElement(actual.DesktopAgentMessage, props);
  } };
});
const { ChatMessageList } = await import('./ChatMessageList');
let root: Root;
let host: HTMLDivElement;
const history: MobileTranscriptEntry[] = Array.from({ length: 8 }, (_, index) => [
  { id: `old-user-${index}`, role: 'user' as const, text: `Request ${index}` },
  { id: `old-assistant-${index}`, role: 'assistant' as const, text: `Completed answer ${index}` },
]).flat();
const live: MobileTranscriptEntry[] = [...history,
  { id: 'live-user', role: 'user', text: 'Current request' },
  { id: 'live-assistant', role: 'assistant', text: 'Current output' },
];
async function render(active: boolean, messages = live, waiting = true) {
  await act(async () => root.render(createElement(ChatMessageList, {
    active, displayMessages: messages, displayWaiting: waiting, isOrchestratorMode: true,
    activeTargetLabel: 'Fixture', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent',
    thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
  })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); observed.rows = [];
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('reuses closed turns when a retained transcript becomes hidden and visible', async () => {
  await render(true);
  observed.rows = [];
  await render(false);
  await render(true);
  expect(observed.rows.filter(row => row.id.startsWith('old-'))).toEqual([]);
  expect(observed.rows.filter(row => row.id === 'live-assistant')).toEqual([
    { id: 'live-assistant', streaming: true, animate: false },
    { id: 'live-assistant', streaming: true, animate: true },
  ]);
  expect(host.textContent).toContain('Completed answer 0');
});
it('still updates changed history and the final live response', async () => {
  await render(false);
  observed.rows = [];
  const changed = live.map(entry => entry.id === 'old-assistant-3' ? { ...entry, text: 'Corrected history' }
    : entry.id === 'live-assistant' ? { ...entry, text: 'Final answer' } : entry);
  await render(false, changed, false);
  expect(host.textContent).toContain('Corrected history');
  expect(host.textContent).toContain('Final answer');
  expect(observed.rows.some(row => row.id === 'old-assistant-3')).toBe(true);
  expect(observed.rows.some(row => row.id === 'live-assistant' && !row.streaming)).toBe(true);
});
it('preserves visible post-stream animation drain on the latest assistant', async () => {
  vi.useFakeTimers();
  const text = 'Draining the final response smoothly. '.repeat(20);
  const messages = live.map(entry => entry.id === 'live-assistant' ? { ...entry, text } : entry);
  try {
    await render(true, messages);
    await act(async () => vi.advanceTimersByTime(20));
    observed.rows = [];
    await render(true, messages, false);
    expect(observed.rows.find(row => row.id === 'live-assistant')).toEqual({ id: 'live-assistant', streaming: false, animate: true });
    expect(host.textContent).not.toContain(text);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).toContain(text);
    expect(observed.rows.filter(row => row.id.startsWith('old-'))).toEqual([]);
  } finally { vi.useRealTimers(); }
});
