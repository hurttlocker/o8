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
  ['GitHub', 'https://github.com/hurttlocker/o8'],
  ['Documentation', 'https://github.com/hurttlocker/o8/tree/main/docs'],
  ['Releases', 'https://github.com/hurttlocker/o8/releases/latest'],
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
});

async function mount() {
  await act(async () => {
    root.render(createElement('div', null, createElement(AboutTab), createElement(ConfirmToastHost)));
  });
}

function linkButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((row) => row.textContent?.startsWith(label));
  expect(button).toBeDefined();
  return button!;
}

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
