export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { browserAgentEval } from '@/lib/mcp/o8-webview-tools';
import { getBrowserEngine } from '@/lib/browser-engine/engine';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket } from '@/lib/lane/registry';

/**
 * Browser-verb bridge for the `o8 browser` CLI (#1232) — gated in middleware
 * (loopback + token). Two tiers behind one contract:
 *
 *   - EMBEDDED (phase 1): the verb evals into the in-page agent riding o8's
 *     own browser surfaces over the Tauri webview socket. Localhost pages.
 *   - ENGINE (phase 3): playwright-core drives the user's installed Chrome
 *     headless for external URLs the iframes can't show. One isolated
 *     context per scope (packetId or 'operator'); the canvas browser card
 *     live-views it via /api/browser/engine/view.
 *
 * Routing: `open` picks the tier by URL (external → engine). Other verbs
 * honor an explicit `surface: 'engine'`, else continue on the engine when
 * the scope already has a live engine page, else go embedded.
 *
 * Worker calls carry a packetId so every action lands in the lane's audit
 * trail as a `browser_acted` event.
 */

const VERBS = new Set(['read', 'click', 'type', 'probe', 'open', 'close']);

interface AgentBody {
  verb?: unknown;
  args?: unknown;
  packetId?: unknown;
}

function webviewClient(): O8WebviewClient {
  const store = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!store.__o8BrowserAgentClient) store.__o8BrowserAgentClient = new O8WebviewClient();
  return store.__o8BrowserAgentClient;
}

function isLocalUrl(url: string): boolean {
  if (url.startsWith('/')) return true;
  try {
    const host = new URL(url.includes('://') ? url : `http://${url}`).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return true; // unparseable → let the embedded tier report it
  }
}

function recordAction(packetId: string, verb: string, args: Record<string, unknown>, ok: boolean, url?: string, surface?: string) {
  try {
    const lane = findLatestLaneByPacket(packetId);
    if (!lane) return;
    recordLaneEvent(lane.id, 'browser_acted', 'system', {
      packetId,
      verb,
      ok,
      ...(typeof args.selector === 'string' ? { selector: String(args.selector).slice(0, 200) } : {}),
      ...(surface ? { surface } : typeof args.surface === 'string' ? { surface: args.surface } : {}),
      ...(url ? { url: url.slice(0, 200) } : {}),
    });
  } catch (error) {
    // The audit trail must never fail the action itself.
    console.error('[browser-agent] browser_acted event failed:', error);
  }
}

/** Best-effort reveal of the live-view tab in the canvas browser card. */
async function revealEngineView(scope: string): Promise<void> {
  try {
    const code = `(() => { try { window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: ${JSON.stringify(`o8-engine://${scope}`)} } })); return 'ok'; } catch { return 'skip'; } })()`;
    await webviewClient().evalJs(code);
  } catch {
    // Engine works headless even when the o8 window is closed.
  }
}

async function runEngineVerb(verb: string, scope: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const engine = getBrowserEngine();
  const selector = typeof args.selector === 'string' ? args.selector : '';
  switch (verb) {
    case 'open': {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const result = await engine.open(scope, url);
      if (result.ok) void revealEngineView(scope);
      return result;
    }
    case 'read':
      return engine.read(scope, typeof args.maxChars === 'number' ? args.maxChars : undefined);
    case 'click':
      if (!selector) return { ok: false, error: 'click requires a selector' };
      return engine.click(scope, selector);
    case 'type':
      if (!selector) return { ok: false, error: 'type requires a selector' };
      return engine.type(scope, selector, typeof args.text === 'string' ? args.text : '', args.submit === true);
    case 'probe':
      return engine.probe(scope, selector, typeof args.text === 'string' ? args.text : undefined);
    case 'close':
      return engine.close(scope);
    default:
      return { ok: false, error: `engine does not support verb ${verb}` };
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AgentBody | null;
  const verb = typeof body?.verb === 'string' ? body.verb : '';
  if (!VERBS.has(verb)) {
    return NextResponse.json({ ok: false, error: `verb must be one of ${[...VERBS].join(', ')}` }, { status: 400 });
  }
  const args = (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  const packetId = typeof body?.packetId === 'string' && body.packetId ? body.packetId : null;
  const scope = packetId ?? 'operator';

  // Tier routing — explicit surface wins; `open` splits on URL locality;
  // other verbs stick with the engine once the scope has a live page.
  const engine = getBrowserEngine();
  const wantsEngine = args.surface === 'engine'
    || (verb === 'open' && typeof args.url === 'string' && args.url.trim() !== '' && !isLocalUrl(args.url.trim()))
    || (verb !== 'open' && args.surface === undefined && engine.hasSession(scope))
    || verb === 'close';

  try {
    if (wantsEngine) {
      const result = await runEngineVerb(verb, scope, args);
      const ok = result.ok === true;
      const url = typeof result.url === 'string' ? result.url : undefined;
      if (packetId && verb !== 'probe') recordAction(packetId, verb, args, ok, url, 'engine');
      return NextResponse.json(result);
    }

    const client = webviewClient();
    if (verb === 'open') {
      const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : null;
      const code = `(() => { try { window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: ${JSON.stringify(url)} } })); return '{"ok":true}'; } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); } })()`;
      const result = await client.evalJs(code);
      if (packetId) recordAction(packetId, verb, args, true, url ?? undefined);
      return NextResponse.json({ ok: true, url, raw: result.result });
    }
    if (verb === 'probe') {
      // One-shot probe — the CLI loops client-side for waits.
      const result = await client.evalJs(browserAgentEval('probe', args));
      return new NextResponse(result.result, { headers: { 'content-type': 'application/json' } });
    }
    const result = await client.evalJs(browserAgentEval(verb as 'read' | 'click' | 'type', args));
    let ok = false;
    let url: string | undefined;
    try {
      const parsed = JSON.parse(result.result) as { ok?: boolean; url?: string };
      ok = parsed.ok === true;
      url = typeof parsed.url === 'string' ? parsed.url : undefined;
    } catch {
      // envelope stays raw
    }
    if (packetId) recordAction(packetId, verb, args, ok, url);
    return new NextResponse(result.result, { headers: { 'content-type': 'application/json' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'browser agent bridge failed',
      hint: wantsEngine
        ? 'Engine tier — is Google Chrome installed? The engine drives the installed Chrome headless.'
        : 'The o8 app window must be running — the bridge rides the Tauri webview socket.',
    });
  }
}
