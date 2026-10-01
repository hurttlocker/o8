// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexCliUpdateNotice } from './CodexCliUpdateNotice';

let container: HTMLDivElement;
let root: Root;
const tool = { runtimeId: 'codex', label: 'Codex CLI', installedVersion: '0.144.1', latestVersion: '0.159.3', status: 'update-available', updateUrl: 'https://learn.chatgpt.com/docs/codex/cli' };
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(createElement(CodexCliUpdateNotice)); }); };
describe('Codex notice from the release response', () => {
  it.each(['current', 'unknown', 'not-installed'])('does not notify for %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tools: [{ ...tool, status }] }))));
    await mount(); expect(container.textContent).toBe('');
  });
  it('shows versions, installs only on click, and displays verified success', async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : new Response(JSON.stringify({ tools: [tool] })));
    vi.stubGlobal('fetch', fetchMock); await mount();
    expect(container.textContent).toContain('0.144.1 → 0.159.3'); expect(fetchMock).toHaveBeenCalledTimes(1);
    const button = container.querySelector('button')!;
    await act(async () => button.click()); expect(button.disabled).toBe(true); expect(container.textContent).toContain('Updating…');
    await act(async () => finish!(new Response(JSON.stringify({ status: 'succeeded', installedVersion: '0.159.3' }))));
    expect(container.textContent).toContain('installed and verified'); expect(container.textContent).toContain('Codex updated');
  });
  it('displays failure and manual instructions without claiming success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST'
      ? { code: 'manual-update', error: 'Use the selected installation package manager.' } : { tools: [tool] }), { status: init?.method === 'POST' ? 409 : 200 })));
    await mount(); await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('Use the selected installation package manager.');
    expect(container.querySelector('a')?.textContent).toContain('instructions'); expect(container.textContent).not.toContain('Codex updated');
  });
  it('dismisses only the offered release without installing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tools: [tool] }))); vi.stubGlobal('fetch', fetchMock);
    await mount(); await act(async () => (container.querySelector('[aria-label="Dismiss Codex update"]') as HTMLButtonElement).click());
    expect(container.textContent).toBe(''); expect(localStorage.getItem('o8:codex-cli-update:dismissed')).toBe('0.159.3'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
