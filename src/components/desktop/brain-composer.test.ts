// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { InputButtons } from './thoughts/InputButtons';
vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { div: 'div' }, useReducedMotion: () => true }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: 'preview-user' } }) }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ flags: { 'proxy.inference': true } }) }));
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));
vi.mock('./thoughts/MicButton', () => ({ MicButton: () => null }));
vi.mock('./thoughts/AttachFilesButton', () => ({ AttachFilesButton: () => null }));

it('opens Brain beside the real composer, sends only on submit, and restores focus without sending the workspace draft', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes('operator-defaults')
    ? Response.json({ values: { brainRoutingMode: 'auto' } })
    : new Response('event: token\ndata: {"text":"A scoped Brain answer."}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const send = vi.fn();
  try {
    await act(async () => root.render(createElement(InputButtons, { input: 'Unsent workspace draft', enhancing: false, preEnhanceInput: null, onEnhance: vi.fn(), onUndoEnhance: vi.fn(), onSubmit: send, repoPath: '/preview/brain-composer' })));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Open Brain"]'); expect(trigger).not.toBeNull();
    await act(async () => { trigger!.focus(); trigger!.click(); });
    const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Brain preview"]')!;
    expect(panel).not.toBeNull(); expect(trigger!.getAttribute('aria-expanded')).toBe('true'); expect(panel.textContent).toContain('o8 managed');
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes('/api/cortex/ask'))).toHaveLength(0);
    const input = panel.querySelector('textarea')!;
    expect(document.activeElement).toBe(input);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'What should we look at next?'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => panel.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(panel.textContent).toContain('A scoped Brain answer.'); expect(send).not.toHaveBeenCalled();
    const request = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('/api/cortex/ask'))!;
    const body = JSON.parse(String((request as unknown as [string, RequestInit])[1].body));
    expect(body.repoPath).toBe('/preview/brain-composer'); expect(body.question).not.toContain('Unsent workspace draft');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
    await act(async () => trigger!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).not.toBeNull();
    await act(async () => root.render(createElement(InputButtons, { input: 'Unsent workspace draft', enhancing: false, preEnhanceInput: null, onEnhance: vi.fn(), onUndoEnhance: vi.fn(), onSubmit: send, repoPath: '/preview/brain-composer', brainActive: false })));
    expect(document.querySelector('[role="dialog"][aria-label="Brain preview"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});
