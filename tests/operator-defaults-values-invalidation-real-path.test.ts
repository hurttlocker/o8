// @vitest-environment jsdom

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-settings-values-invalidation-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: { profile: null, detail: null } })),
  getDispatchableRuntimeAvailability: vi.fn(async () => []),
  invalidateRuntimeAuthCache: vi.fn(),
}));

const route = await import('@/app/api/panel/operator-defaults/route');
const { closeDb } = await import('@/lib/db');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { fetchThoughtsOperatorDefaults } = await import('@/components/desktop/thoughts/operator-defaults');
const { usePrLinkDestinationFlag } = await import('@/lib/operator/use-pr-link-destination');
const { invalidateOperatorDefaultsValuesSnapshot, updateOperatorDefaultsValues } = await import('@/lib/operator/operator-defaults-values-client');

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  invalidateOperatorDefaultsValuesSnapshot();
  vi.unstubAllGlobals();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function Destination() {
  return createElement('output', null, usePrLinkDestinationFlag());
}

it('keeps the saved setting visible when a pre-save value read finishes after a newer read', async () => {
  const endpoint = 'http://localhost/api/panel/operator-defaults';
  const initial = await route.POST(new Request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prLinkDestination: 'in-app' }),
  }));
  expect(initial.status).toBe(200);
  const beforeSave = await route.GET(new Request(`${endpoint}?include=values`));
  let releaseOldRead!: (response: Response) => void;
  const oldReadGate = new Promise<Response>((resolve) => { releaseOldRead = resolve; });
  let reads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), endpoint), init);
    if (request.method === 'POST') return route.POST(request);
    expect(request.url).toBe(`${endpoint}?include=values`);
    reads += 1;
    return reads === 1 ? oldReadGate : route.GET(request);
  });
  vi.stubGlobal('fetch', fetchMock);
  invalidateOperatorDefaultsValuesSnapshot();

  // A real composer data read captures the old settings, then its transport
  // reply is held while another surface successfully saves the new choice.
  const oldRead = fetchThoughtsOperatorDefaults();
  expect(reads).toBe(1);
  const saved = await updateOperatorDefaultsValues({ prLinkDestination: 'browser' });
  expect(saved.status).toBe(200);
  expect(parseOperatorDefaultsToml(readFileSync(join(dataDir, 'settings.toml'), 'utf8')))
    .toMatchObject({ prLinkDestination: 'browser' });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // Hold the cache clock so a loaded test host cannot accidentally bypass the
  // stale snapshot by exhausting its one-second TTL before the mount.
  const clockSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    // Seed the current shared snapshot, then let the obsolete transport finish.
    await fetchThoughtsOperatorDefaults();
    expect(reads).toBe(2);
    releaseOldRead(beforeSave);
    await oldRead;
    await act(async () => { root.render(createElement(Destination)); });
    expect(container.textContent).toBe('browser');
    expect(reads).toBe(2);
  } finally {
    clockSpy.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
