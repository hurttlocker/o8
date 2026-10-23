// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as external from '@/lib/desktop/open-external';
import { ConfirmToastHost } from '@/components/shared/ConfirmToastHost';
import { AboutTab } from './AboutTab';

const { shellOpen } = vi.hoisted(() => ({ shellOpen: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }));
vi.mock('./ReportIssueSection', () => ({ ReportIssueSection: () => null }));

const links = [
  ['GitHub', 'https://github.com/o8-run/o8'],
  ['Documentation', 'https://github.com/o8-run/o8/tree/main/docs'],
  ['Releases', 'https://github.com/o8-run/o8/releases/latest'],
] as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  shellOpen.mockReset().mockResolvedValue(undefined);
  vi.spyOn(window, 'open').mockReturnValue(null);
  vi.spyOn(external, 'openExternalUrl');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount() {
  await act(async () => {
    root.render(createElement('div', null, createElement(AboutTab), createElement(ConfirmToastHost)));
  });
}

it('requests a fresh native check from the actual About control without applying it', async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true, requested: false, result: { code: 'check_available' },
    state: { updatePending: true, version: '0.1.999', check: { outcome: 'available', checkedAt: new Date().toISOString(), error: null } } }));
  vi.stubGlobal('fetch', fetchMock);
  await mount();
  await act(async () => linkButton('Check for updates').click());
  expect(fetchMock).toHaveBeenCalledWith('/api/panel/update/apply', expect.objectContaining({ method: 'POST', body: JSON.stringify({ checkOnly: true }) }));
  expect(container.textContent).toContain('Update 0.1.999 is ready.');
});

function linkButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((row) => row.textContent?.startsWith(label));
  expect(button).toBeDefined();
  return button!;
}

it('shows staged progress while waiting for the native check and clears it on completion', async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  await mount();
  await act(async () => linkButton('Check for updates').click());
  expect([...container.querySelectorAll('button')].some(row => row.textContent?.startsWith('Check for updates'))).toBe(false);
  expect(container.textContent).toContain('Requesting a fresh check…');
  await act(async () => { vi.advanceTimersByTime(1_000); });
  expect(container.textContent).toContain('Waiting for the native updater…');
  expect(container.querySelector('progress')).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(2_000); });
  expect(container.textContent).toContain('Waiting for the release check to finish…');
  await act(async () => finish(Response.json({ ok: true, state: { check: { outcome: 'current' } } })));
  expect(container.textContent).toContain('o8 is up to date.');
  expect(linkButton('Check for updates').disabled).toBe(false);
  expect(container.querySelector('progress')).toBeNull();
});

it.each(links)('opens %s through the native-aware helper from the rendered row', async (label, url) => {
  await mount();
  await act(async () => linkButton(label).click());
  expect(external.openExternalUrl).toHaveBeenCalledExactlyOnceWith(url);
  await vi.waitFor(() => expect(shellOpen).toHaveBeenCalledExactlyOnceWith(url));
  expect(window.open).not.toHaveBeenCalled();
});

it.each(links)('routes keyboard-generated activation of %s through the same helper', async (label, url) => {
  await mount();
  const button = linkButton(label);
  expect(button.type).toBe('button');
  button.focus();
  expect(document.activeElement).toBe(button);
  // jsdom does not implement Enter/Space default activation. Native buttons
  // deliver a click with detail=0 for keyboard activation; exercise that event.
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  expect(external.openExternalUrl).toHaveBeenCalledExactlyOnceWith(url);
  await vi.waitFor(() => expect(shellOpen).toHaveBeenCalledExactlyOnceWith(url));
  expect(window.open).not.toHaveBeenCalled();
});

it('keeps the browser preview path when a rendered link is activated', async () => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  await mount();
  await act(async () => linkButton('Documentation').click());
  expect(external.openExternalUrl).toHaveBeenCalledExactlyOnceWith(links[1][1]);
  expect(window.open).toHaveBeenCalledExactlyOnceWith(links[1][1], '_blank', 'noopener,noreferrer');
  expect(shellOpen).not.toHaveBeenCalled();
});

it('shows an opening failure after the real About row reaches an unavailable native opener', async () => {
  shellOpen.mockRejectedValueOnce(new Error('opener unavailable'));
  await mount();
  await act(async () => {
    linkButton('Releases').click();
    await vi.waitFor(() => expect(shellOpen).toHaveBeenCalledExactlyOnceWith(links[2][1]));
  });
  expect(container.textContent).toContain('Could not open this link. Please try again.');
  expect(shellOpen).toHaveBeenCalledExactlyOnceWith(links[2][1]);
  expect(window.open).not.toHaveBeenCalled();
});
