export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

/**
 * Canvas intent bus (#1232 phase 2) — gated in middleware (loopback + token).
 * Symon (and any local agent surface) drives the canvas through one POST:
 * the verb rides into the webview as an `o8:canvas-intent` CustomEvent, whose
 * listener executes the SAME handlers the canvas rail buttons call. Dispatch
 * is synchronous in the page, so the ack stamped on window.__o8CanvasIntentLast
 * is read back in the same eval.
 *
 * `ensure` (default true) navigates the webview to the canvas route first when
 * it's somewhere else, then waits for the intent listener to mount.
 */

const VERBS = new Set(['open-browser', 'ask-brain', 'open-spec', 'spawn-terminal', 'search', 'zoom', 'dock', 'send-prompt']);
const CANVAS_ROUTE = '/preview/canvas-glass';
const READY_POLL_MS = 300;
const READY_TIMEOUT_MS = 10_000;

interface IntentBody {
  verb?: unknown;
  args?: unknown;
  ensure?: unknown;
}

interface DispatchProbe {
  ready: boolean;
  route?: string;
  ack?: { verb: string | null; ok: boolean; note: string | null } | null;
}

function webviewClient(): O8WebviewClient {
  // Same global key as /api/browser/agent — one socket connection per server.
  const store = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!store.__o8BrowserAgentClient) store.__o8BrowserAgentClient = new O8WebviewClient();
  return store.__o8BrowserAgentClient;
}

function dispatchEval(verb: string, args: Record<string, unknown>): string {
  return `(() => {
    const w = window;
    if (w.__o8CanvasIntentReady !== true) {
      return JSON.stringify({ ready: false, route: location.pathname });
    }
    w.dispatchEvent(new CustomEvent('o8:canvas-intent', { detail: { verb: ${JSON.stringify(verb)}, args: ${JSON.stringify(args)} } }));
    return JSON.stringify({ ready: true, route: location.pathname, ack: w.__o8CanvasIntentLast || null });
  })()`;
}

async function probeDispatch(client: O8WebviewClient, verb: string, args: Record<string, unknown>): Promise<DispatchProbe> {
  const result = await client.evalJs(dispatchEval(verb, args));
  try {
    return JSON.parse(result.result) as DispatchProbe;
  } catch {
    return { ready: false };
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as IntentBody | null;
  const verb = typeof body?.verb === 'string' ? body.verb : '';
  if (!VERBS.has(verb)) {
    return NextResponse.json({ ok: false, error: `verb must be one of ${[...VERBS].join(', ')}` }, { status: 400 });
  }
  const args = (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  const ensure = body?.ensure !== false;

  try {
    const client = webviewClient();
    let probe = await probeDispatch(client, verb, args);
    let navigated = false;

    if (!probe.ready && ensure) {
      if (probe.route && probe.route !== CANVAS_ROUTE) {
        await client.navigate(CANVAS_ROUTE);
        navigated = true;
      }
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!probe.ready && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
        probe = await probeDispatch(client, verb, args);
      }
    }

    if (!probe.ready) {
      return NextResponse.json({
        ok: false,
        error: probe.route === CANVAS_ROUTE
          ? 'canvas intent listener never came up — is "Experimental: Canvas mode" enabled in Settings?'
          : `canvas not open (current route: ${probe.route ?? 'unknown'})`,
        route: probe.route ?? null,
        navigated,
      });
    }

    const ack = probe.ack && probe.ack.verb === verb ? probe.ack : null;
    return NextResponse.json({
      ok: ack ? ack.ok : true,
      verb,
      ...(ack?.note ? { note: ack.note } : {}),
      ...(navigated ? { navigated: true } : {}),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'canvas intent bridge failed',
      hint: 'The o8 app window must be running — the bridge rides the Tauri webview socket.',
    });
  }
}
