// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectedAgentAutomations } from './ConnectedAgentAutomations';

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

it('shows the source schedule and changes the source job through the connected route', async () => {
  let enabled = true;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { id: string; enabled: boolean };
      expect(body).toEqual({ id: 'job-1', enabled: false });
      enabled = false;
      return Response.json({ ok: true, job: { id: 'job-1', enabled } });
    }
    return Response.json({ ok: true, available: true, jobs: [{
      id: 'job-1', name: 'Daily planning check-in', agentId: 'symon', enabled,
      schedule: { kind: 'cron', expr: '0 11 * * *', tz: 'America/New_York', everyMs: null, at: null },
      nextRunAt: Date.now() + 86_400_000, lastRunAt: Date.now() - 86_400_000,
      lastRunStatus: 'ok', lastDeliveryStatus: 'delivered',
    }] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onActiveCountChange = vi.fn();
  await act(async () => {
    root.render(createElement(ConnectedAgentAutomations, { onActiveCountChange }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain('Daily at 11:00 AM · America/New_York');
  expect(container.textContent).toContain('symon');
  expect(onActiveCountChange).toHaveBeenLastCalledWith(1);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  expect(onActiveCountChange).toHaveBeenLastCalledWith(0);
});
