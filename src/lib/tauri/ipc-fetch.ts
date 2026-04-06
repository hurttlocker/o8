/**
 * ipcFetch — Tauri IPC acceleration for hot-path API calls.
 *
 * When running in Tauri desktop, maps known API paths to Rust `invoke()`
 * commands that bypass the HTTP stack entirely (~0.5ms vs ~5-10ms).
 * Falls back to regular fetch() for unmapped paths or browser mode.
 *
 * Usage:
 *   // Drop-in replacement for fetch on hot paths:
 *   const data = await ipcFetch('/api/panel/repos');
 *   const json = await data.json();
 *
 *   // Or use the typed helper directly:
 *   const repos = await ipcInvoke<{ repos: RepoEntry[] }>('read_repos');
 */

import { isTauri } from './bridge';

// ── IPC route mapping ──

interface IpcRoute {
  cmd: string;
  parseArgs?: (url: URL) => Record<string, unknown>;
}

const IPC_ROUTES: Record<string, IpcRoute> = {
  '/api/panel/repos': {
    cmd: 'read_repos',
  },
  '/api/panel/commits': {
    cmd: 'read_local_commits',
    parseArgs: (url) => ({
      repo: url.searchParams.get('workspace') || url.searchParams.get('repo') || '',
      limit: parseInt(url.searchParams.get('limit') || '10', 10),
    }),
  },
  '/api/worktrees': {
    cmd: 'read_worktrees',
    parseArgs: (url) => ({
      repo: url.searchParams.get('repo') || '',
    }),
  },
};

// ── Typed invoke helper ──

let _invokeModule: typeof import('@tauri-apps/api/core') | null = null;

async function getInvoke() {
  if (!_invokeModule) {
    _invokeModule = await import('@tauri-apps/api/core');
  }
  return _invokeModule.invoke;
}

/**
 * Invoke a Tauri command directly with type safety.
 * Returns null if not in Tauri or command fails.
 */
export async function ipcInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const invoke = await getInvoke();
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[ipc-fetch] ${cmd} failed:`, err);
    return null;
  }
}

// ── Fetch replacement ──

/**
 * IPC-accelerated fetch. For mapped API paths in Tauri, uses invoke()
 * instead of HTTP. Returns a standard Response object for compatibility.
 *
 * Only accelerates GET requests. POST/PUT/DELETE always go through HTTP.
 */
export async function ipcFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // Only intercept in Tauri, only for GET requests
  if (!isTauri() || (init?.method && init.method !== 'GET')) {
    return fetch(input, init);
  }

  const urlStr = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  // Parse the URL to match against IPC routes
  let url: URL;
  try {
    url = new URL(urlStr, 'http://localhost:3001');
  } catch {
    return fetch(input, init);
  }

  const route = IPC_ROUTES[url.pathname];
  if (!route) {
    return fetch(input, init);
  }

  try {
    const invoke = await getInvoke();
    const args = route.parseArgs?.(url) ?? {};

    // Skip IPC if required args are missing
    if (route.parseArgs && args.repo === '') {
      return fetch(input, init);
    }

    const data = await invoke(route.cmd, args);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn(`[ipc-fetch] ${route.cmd} failed, falling back to HTTP:`, err);
    return fetch(input, init);
  }
}
