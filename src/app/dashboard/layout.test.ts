/**
 * Real-path test for the dashboard layout's credential handling — driven through
 * `generateMetadata()`, the function Next itself calls to build the page head.
 *
 * Live failure (2026-07-29, #1639): the dashboard embedded the ws-token in every
 * response, so serving it through a machine relay tripped the connector's
 * credential-leak guard and the browser saw an empty 502. HEAD /dashboard returned 200
 * and /voice-settings (64KB, larger) tunnelled fine — only the token-bearing page died.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  O8_RELAY_FORWARD_HEADER,
  O8_RELAY_FORWARD_MARKER,
  O8_RELAY_SURFACE_HEADER,
  O8_WEB_MACHINE_SURFACE,
} from '@/lib/connect/web-machine-surface';
import { O8_CLIENT_ADDR_HEADER } from '@/lib/auth/loopback-request';

const headerStore = { current: {} as Record<string, string> };

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => headerStore.current[name.toLowerCase()] ?? null,
  }),
}));

vi.mock('@/lib/ws-auth', () => ({
  getOrCreateWsToken: () => 'test-ws-token-value',
}));

async function metadataFor(requestHeaders: Record<string, string>) {
  headerStore.current = Object.fromEntries(
    Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const { generateMetadata } = await import('./layout');
  return await generateMetadata();
}

describe('dashboard layout — ws-token exposure', () => {
  it('embeds the token for a loopback page load (the desktop webview)', async () => {
    const metadata = await metadataFor({ host: '127.0.0.1:47100' });
    expect(metadata.other?.['ws-token']).toBe('test-ws-token-value');
  });

  it('withholds the token when the page is served through a machine relay', async () => {
    const metadata = await metadataFor({
      host: '127.0.0.1:47100',
      [O8_CLIENT_ADDR_HEADER]: O8_RELAY_FORWARD_MARKER,
      [O8_RELAY_FORWARD_HEADER]: '1',
      [O8_RELAY_SURFACE_HEADER]: O8_WEB_MACHINE_SURFACE,
    });
    expect(metadata.other?.['ws-token']).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain('test-ws-token-value');
  });

  it('withholds the token from a plain non-loopback request', async () => {
    const metadata = await metadataFor({ host: '192.168.1.50:47100' });
    expect(metadata.other?.['ws-token']).toBeUndefined();
  });
});
