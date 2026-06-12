export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { browserAgentEval } from '@/lib/mcp/o8-webview-tools';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket } from '@/lib/lane/registry';

/**
 * Browser-verb bridge for the `o8 browser` CLI (#1232 phase 1) — gated in
 * middleware (loopback + token). Forwards one in-page browser-agent verb
 * into the webview over the Tauri MCP socket and returns its envelope.
 * Worker calls carry a packetId so every action lands in the lane's audit
 * trail as a `browser_acted` event.
 */

const VERBS = new Set(['read', 'click', 'type', 'probe', 'open']);

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

function recordAction(packetId: string, verb: string, args: Record<string, unknown>, ok: boolean, url?: string) {
  try {
    const lane = findLatestLaneByPacket(packetId);
    if (!lane) return;
    recordLaneEvent(lane.id, 'browser_acted', 'system', {
      packetId,
      verb,
      ok,
      ...(typeof args.selector === 'string' ? { selector: String(args.selector).slice(0, 200) } : {}),
      ...(typeof args.surface === 'string' ? { surface: args.surface } : {}),
      ...(url ? { url: url.slice(0, 200) } : {}),
    });
  } catch (error) {
    // The audit trail must never fail the action itself.
    console.error('[browser-agent] browser_acted event failed:', error);
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

  try {
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
      hint: 'The o8 app window must be running — the bridge rides the Tauri webview socket.',
    });
  }
}
