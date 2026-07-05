'use client';

type FetchFn = typeof fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

let warnedFallback = false;

function resolveFetchUrl(input: FetchInput): URL | null {
  try {
    if (typeof input === 'string') {
      if (input.startsWith('plugin:http')) return new URL(input);
      return new URL(input, window.location.origin);
    }
    if (input instanceof URL) return input;
    return new URL(input.url, window.location.origin);
  } catch {
    return null;
  }
}

function hasTauriFetchHeader(input: FetchInput, init?: FetchInit): boolean {
  const initHeaders = init?.headers;
  if (initHeaders instanceof Headers) return initHeaders.has('x-tauri-fetch');
  if (Array.isArray(initHeaders)) return initHeaders.some(([key]) => key.toLowerCase() === 'x-tauri-fetch');
  if (initHeaders) {
    return Object.keys(initHeaders).some((key) => key.toLowerCase() === 'x-tauri-fetch');
  }
  return input instanceof Request && input.headers.has('x-tauri-fetch');
}

export function isClerkBoundFetch(input: FetchInput, init?: FetchInit): boolean {
  if (hasTauriFetchHeader(input, init)) return true;

  const url = resolveFetchUrl(input);
  if (!url) return false;

  if (url.protocol === 'plugin:' && url.href.startsWith('plugin:http')) return true;
  if (decodeURIComponent(url.pathname) === '/plugin:http|fetch') return true;

  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'clerk.o8.run' ||
    hostname === 'api.clerk.com' ||
    hostname.endsWith('.accounts.dev') ||
    hostname.endsWith('.clerk.accounts.dev')
  );
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (error instanceof TypeError && /fetch|network|load failed|cancel/i.test(error.message)) return true;
  return false;
}

function warnNativeFallbackOnce(error: unknown) {
  if (warnedFallback) return;
  warnedFallback = true;
  console.warn('[auth] native Clerk fetch wrapper failed for app traffic; falling back to native fetch', error);
}

export function installTauriClerkFetchGuard(nativeFetch: FetchFn): void {
  const pluginFetch = globalThis.fetch;
  if (pluginFetch === nativeFetch) return;

  const boundNativeFetch = nativeFetch.bind(globalThis);
  const boundPluginFetch = pluginFetch.bind(globalThis);

  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    if (!isClerkBoundFetch(input, init)) {
      return boundNativeFetch(input, init);
    }

    try {
      return await boundPluginFetch(input, init);
    } catch (error) {
      if (!isLikelyNetworkError(error) && !isClerkBoundFetch(input, init)) {
        warnNativeFallbackOnce(error);
        return boundNativeFetch(input, init);
      }
      throw error;
    }
  }) as FetchFn;
}

export function resetTauriClerkFetchGuardForTests(): void {
  warnedFallback = false;
}
