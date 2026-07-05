'use client';

type FetchFn = typeof fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

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

export function installTauriClerkFetchGuard(nativeFetch: FetchFn): void {
  const pluginFetch = globalThis.fetch;
  if (pluginFetch === nativeFetch) return;

  const boundNativeFetch = nativeFetch.bind(globalThis);
  const boundPluginFetch = pluginFetch.bind(globalThis);

  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    // Non-Clerk traffic NEVER touches the plugin wrapper — this is the whole
    // guard. Clerk-bound traffic goes to the plugin and its errors propagate
    // to clerk-js untouched; falling back to native fetch for Clerk traffic
    // would silently reintroduce the WKWebView cookie problem native mode
    // exists to solve.
    if (!isClerkBoundFetch(input, init)) {
      return boundNativeFetch(input, init);
    }
    return boundPluginFetch(input, init);
  }) as FetchFn;
}
