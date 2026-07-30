/**
 * Pending-result registry for the native browser-view secure channel
 * (docs/internals/native-browser-webview-spec.md, Stage 4).
 *
 * The browser-view page is untrusted and has NO Tauri IPC bridge (see
 * `native_browser_view_security`), so an eval result can't come back via
 * `mcp_result`. Instead the injected agent verb POSTs its result (cross-origin,
 * no-cors text/plain — full body, no WebKit custom-scheme limits) to
 * `/api/browser/native-result`, keyed by a correlation id. The o8_browser_*
 * route awaits the matching pending promise here and returns it.
 *
 * The two routes (the verb dispatcher + the result receiver) are separate Next
 * modules but run in the SAME Node process, so a `globalThis`-backed Map is the
 * shared rendezvous. The id is unguessable enough that a stray loopback POST
 * can't resolve someone else's eval; a wrong/late cid is simply ignored.
 */

interface Pending {
  resolve: (payload: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function registry(): Map<string, Pending> {
  const g = globalThis as { __o8NativeResults?: Map<string, Pending> };
  if (!g.__o8NativeResults) g.__o8NativeResults = new Map();
  return g.__o8NativeResults;
}

let counter = 0;

/** A correlation id for one native-verb round-trip. */
export function newNativeCid(): string {
  counter += 1;
  return `nbv-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Register a pending result and await it; resolves with a timeout envelope if
 *  the browser-view agent never POSTs back (window gone, page navigated away). */
export function awaitNativeResult(cid: string, timeoutMs: number): Promise<unknown> {
  const reg = registry();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      reg.delete(cid);
      resolve({ ok: false, error: 'native browser-view result timed out', timedOut: true });
    }, timeoutMs);
    reg.set(cid, { resolve, timer });
  });
}

/** Resolve a pending result (called by /api/browser/native-result on the POST
 *  from the browser-view agent). Returns false if no pending matches the cid. */
export function resolveNativeResult(cid: string, payload: unknown): boolean {
  const reg = registry();
  const pending = reg.get(cid);
  if (!pending) return false;
  clearTimeout(pending.timer);
  reg.delete(cid);
  pending.resolve(payload);
  return true;
}
