// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrainPipButton } from './brain/BrainPipButton';
import { openComposerBrain } from './brain/brain-events';
vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { div: 'div', path: 'path' }, useReducedMotion: () => true }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: 'preview-user' } }) }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ flags: { 'proxy.inference': true } }) }));
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));
vi.mock('./thoughts/MicButton', () => ({ MicButton: () => null }));
vi.mock('./thoughts/AttachFilesButton', () => ({ AttachFilesButton: () => null }));

it('anchors Brain to the composer, sends only on submit, and restores focus without sending the workspace draft', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(100, 600, 500, 100)] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 600, 500, 100));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes('operator-defaults')
    ? Response.json({ values: { brainRoutingMode: 'auto' } })
    : new Response('event: token\ndata: {"text":"A scoped Brain answer."}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const send = vi.fn();
  try {
    await act(async () => root.render(createElement(BrainPipButton, { repoPath: '/preview/brain-composer' })));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Open Brain"]'); expect(trigger).not.toBeNull(); expect(trigger!.hasAttribute('data-brain-dock-tab')).toBe(true);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Brain preview"]')!;
    expect(panel).not.toBeNull(); expect(panel.getBoundingClientRect).toBeDefined(); expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.height)).toBeLessThan(600); expect(trigger!.getAttribute('aria-expanded')).toBe('true'); expect(panel.textContent).toContain('o8 managed');
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes('/api/cortex/ask'))).toHaveLength(0);
    await act(async () => openComposerBrain({ repoPath: '/preview/other', prompt: 'Wrong repo' }));
    expect(panel.querySelector('textarea')!.value).toBe('');
    await act(async () => openComposerBrain({ repoPath: '/preview/brain-composer', prompt: 'Review this step', context: '{"number":17}' }));
    expect(panel.querySelector('textarea')!.value).toBe('Review this step');
    const input = panel.querySelector('textarea')!;
    expect(document.activeElement).toBe(input);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'What should we look at next?'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => panel.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(panel.textContent).toContain('A scoped Brain answer.'); expect(send).not.toHaveBeenCalled();
    const request = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/api/cortex/ask'))!;
    const body = JSON.parse(String((request as unknown as [string, RequestInit])[1].body));
    expect(body.repoPath).toBe('/preview/brain-composer'); expect(body.question).not.toContain('Unsent workspace draft'); expect(body.question).toContain('{"number":17}');
    await act(async () => trigger!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).toBeNull();
    await act(async () => trigger!.click());
    expect(document.body.textContent).toContain('A scoped Brain answer.');
    await act(async () => document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
    await act(async () => trigger!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).not.toBeNull();
    await act(async () => root.render(createElement(BrainPipButton, { repoPath: '/preview/brain-composer', active: false })));
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
