// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SymonIMessageAccessSection } from './SymonIMessageAccessSection';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows an explicit confirmation before granting every approved member full access', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Response.json({
        ok: true,
        group: { id: '68', label: 'Family group', memberSuffixes: ['0101', '0102'], approvalVersion: 'v1', fullAccess: true, canGrant: true },
      });
    }
    return Response.json({
      ok: true,
      configured: true,
      enabled: true,
      groups: [{ id: '68', label: 'Family group', memberSuffixes: ['0101', '0102'], approvalVersion: 'v1', fullAccess: false, canGrant: true }],
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  await act(async () => {
    root.render(createElement(SymonIMessageAccessSection));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain('Family group');
  const toggle = container.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1];
  expect(toggle?.getAttribute('aria-checked')).toBe('false');
  await act(async () => { toggle?.click(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Give these approved members the same Symon tool access');

  await act(async () => {
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Grant full access')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const posted = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
  expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
    groupId: '68', fullAccess: true, confirm: 'grant-all-approved-members', approvalVersion: 'v1',
  });
  expect(toggle?.getAttribute('aria-checked')).toBe('true');
});

it('shows a master switch even when no groups are configured', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ ok: true, enabled: false });
    return Response.json({ ok: true, configured: true, enabled: true, groups: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(SymonIMessageAccessSection));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain('Allow Symon on iMessage');
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(toggle?.getAttribute('aria-checked')).toBe('true');
  await act(async () => {
    toggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body)))
    .toEqual({ enabled: false });
  expect(toggle?.getAttribute('aria-checked')).toBe('false');
});
