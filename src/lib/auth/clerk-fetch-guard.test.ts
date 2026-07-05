// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installTauriClerkFetchGuard,
  isClerkBoundFetch,
  resetTauriClerkFetchGuardForTests,
} from './clerk-fetch-guard';

describe('tauri Clerk fetch guard', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetTauriClerkFetchGuardForTests();
    window.history.replaceState(null, '', '/dashboard');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    resetTauriClerkFetchGuardForTests();
  });

  it('bypasses a throwing plugin interceptor for app API traffic', async () => {
    const nativeFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const pluginFetch = vi.fn(() => {
      throw new Error('URL@[native code]');
    }) as unknown as typeof fetch;

    globalThis.fetch = pluginFetch;
    installTauriClerkFetchGuard(nativeFetch);

    const response = await fetch('/api/panel/repos');

    expect(await response.text()).toBe('ok');
    expect(nativeFetch).toHaveBeenCalledWith('/api/panel/repos', undefined);
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it('delegates Clerk and plugin-http traffic to the plugin fetch wrapper', async () => {
    const nativeFetch = vi.fn(async () => new Response('native', { status: 200 })) as unknown as typeof fetch;
    const pluginFetch = vi.fn(async () => new Response('plugin', { status: 200 })) as unknown as typeof fetch;

    globalThis.fetch = pluginFetch;
    installTauriClerkFetchGuard(nativeFetch);

    await fetch('https://clerk.o8.run/v1/client');
    await fetch('http://ipc.localhost/plugin:http|fetch');
    await fetch('/api/panel/entitlement/sync', {
      headers: { 'x-tauri-fetch': '1' },
    });

    expect(pluginFetch).toHaveBeenCalledTimes(3);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('identifies the Clerk Frontend API domains without treating app routes as Clerk-bound', () => {
    expect(isClerkBoundFetch('https://clerk.o8.run/v1/client')).toBe(true);
    expect(isClerkBoundFetch('https://steady-mallard-12.clerk.accounts.dev/v1/client')).toBe(true);
    expect(isClerkBoundFetch('/api/panel/repos')).toBe(false);
  });
});
