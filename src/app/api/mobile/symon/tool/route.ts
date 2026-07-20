export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import {
  TOOL_TIMEOUT_MS,
  parseSymonPendingConfirmation,
  toolTimeoutResult,
  toolErrorResult,
  type SymonToolRelayResult,
} from '@/lib/mobile/symon-tool-relay';
import {
  loadSymonScopeGrant,
  scopeSymonToolArgs,
} from '@/lib/mobile/symon-agent-registry';

/**
 * Symon Agent Mode — INTERNAL tool-relay target (ws-server → Next; same gate).
 *
 * docs/symon-agent-mode.md §POST /api/mobile/symon/tool. NOT called by the phone
 * — the ws-server `symon` channel forwards a phone `symon-tool-call` here, and we
 * execute it through the EXACT same dispatcher + SafetyClass gate the desk
 * session's tool calls run through (`realtime_invoke_tool`), then return
 * `{ ok, result }`. Documented as a route so the relay is auditable.
 *
 * The Tauri command is reached through the RealtimeVoiceHost agent bridge
 * (`window.__o8SymonAgent.invokeTool`) — the same reason the mint route reads
 * tools from the bridge: bare-specifier dynamic imports don't resolve inside a
 * raw eval string, so the webview does the invoke and we poll a window-side
 * result cache keyed by sessionId + callId. 60s cap → tool_timeout (Mac execution is NOT
 * cancelled; a late result is dropped, same as desk mode).
 *
 * Confirm-gated tools keep their cached Rust invoke alive. The exact correlated
 * pending gate is returned to ws-server; after a decision, polling this same
 * route resumes the same promise and returns one terminal tool result.
 *
 * Never throws — structured `{ ok, result }` (always HTTP 200). Log: [symon-agent].
 */

const LOG = '[symon-agent]';
const POLL_INTERVAL_MS = 200;

function webviewClient(): O8WebviewClient {
  const g = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!g.__o8BrowserAgentClient) g.__o8BrowserAgentClient = new O8WebviewClient();
  return g.__o8BrowserAgentClient;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Kick off (once) + poll the webview invoke, correlated by callId in a window
 * cache. `deriveOk` runs in-page (mirrors realtime-client.ts). Slots older than
 * 5 min are reaped so a dropped/late result can't leak memory.
 */
export function buildToolEval(sessionId: string, callId: string, tool: string, args: unknown): string {
  const session = JSON.stringify(sessionId);
  const id = JSON.stringify(callId);
  const name = JSON.stringify(tool);
  const argsJson = JSON.stringify(args ?? {});
  return `(() => {
    const w = window;
    const A = w.__o8SymonAgent;
    const store = (w.__o8SymonToolCalls = w.__o8SymonToolCalls || {});
    const NOW = Date.now();
    for (const k in store) { if (store[k] && NOW - (store[k].startedAt || 0) > 300000) delete store[k]; }
    if (!A || typeof A.invokeTool !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const sessionId = ${session};
    const callId = ${id};
    const key = JSON.stringify([sessionId, callId]);
    let slot = store[key];
    if (!slot) {
      slot = store[key] = { startedAt: NOW, done: false, decisionSubmitted: false, tool: ${name} };
      Promise.resolve().then(() => A.invokeTool(${name}, ${argsJson}, { sessionId, callId })).then((result) => {
        const errored = !!(result && typeof result === 'object' && 'error' in result);
        store[key] = Object.assign(store[key] || {}, { done: true, ok: !errored, result: result });
      }).catch((e) => {
        store[key] = Object.assign(store[key] || {}, { done: true, ok: false, result: { error: 'tool_failed', detail: String((e && e.message) || e) } });
      });
    }
    if (slot.tool !== ${name}) return JSON.stringify({ state: 'call_mismatch' });
    if (slot.done) return JSON.stringify({ state: 'done', ok: slot.ok, result: slot.result });
    if (slot.confirmation && !slot.decisionSubmitted) {
      return JSON.stringify({ state: 'needs_confirmation', confirmation: slot.confirmation });
    }
    if (!slot.confirmation && Array.isArray(A.pendingConfirmations)) {
      const hit = A.pendingConfirmations.find((c) => c && c.sessionId === sessionId && c.callId === callId && c.tool === ${name});
      if (hit) {
        slot.confirmation = hit;
        slot.confirmationId = hit.confirmationId;
        return JSON.stringify({ state: 'needs_confirmation', confirmation: hit });
      }
    }
    return JSON.stringify({ state: 'pending' });
  })()`;
}

async function executeViaBridge(
  sessionId: string,
  callId: string,
  tool: string,
  args: unknown,
): Promise<SymonToolRelayResult> {
  const client = webviewClient();
  const code = buildToolEval(sessionId, callId, tool, args);
  const deadline = Date.now() + TOOL_TIMEOUT_MS;
  let sawBridge = false;

  while (Date.now() < deadline) {
    let parsed: { state?: string; ok?: boolean; result?: unknown; confirmation?: unknown };
    try {
      const { result } = await client.evalJs(code);
      parsed = JSON.parse(result);
    } catch (error) {
      // A hard socket failure before we ever reached the page ⇒ app not running.
      if (!sawBridge) {
        return toolErrorResult('desktop_unavailable', error instanceof Error ? error.message : 'webview eval bridge unreachable');
      }
      // Transient eval hiccup after we've already reached the page — the invoke
      // is still running in the webview; keep polling until the 60s cap.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    sawBridge = true;
    if (parsed.state === 'no_bridge') {
      return toolErrorResult('desktop_unavailable', 'Symon agent bridge not mounted — is the o8 dashboard open?');
    }
    if (parsed.state === 'call_mismatch') {
      return toolErrorResult('call_mismatch', 'This sessionId and callId are already bound to another tool.');
    }
    if (parsed.state === 'done') {
      return { ok: Boolean(parsed.ok), result: parsed.result };
    }
    if (parsed.state === 'needs_confirmation') {
      const confirmation = parseSymonPendingConfirmation(parsed.confirmation, { sessionId, callId, tool });
      if (!confirmation) {
        return toolErrorResult('confirmation_mismatch', 'The desktop returned an uncorrelated confirmation.');
      }
      return {
        ...toolErrorResult('needs_confirmation', 'Approval is required before this action can run.'),
        confirmation,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`${LOG} tool_timeout callId=${callId} tool=${tool}`);
  return toolTimeoutResult();
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as
    | { sessionId?: unknown; callId?: unknown; tool?: unknown; args?: unknown; dryRun?: unknown }
    | null;

  const callId = typeof body?.callId === 'string' ? body.callId : '';
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const args = body?.args !== undefined && body?.args !== null && typeof body.args === 'object' ? body.args : {};

  if (!sessionId || !tool || !callId) {
    return NextResponse.json(toolErrorResult('bad_request', 'sessionId, callId, and tool are required'));
  }

  const grant = loadSymonScopeGrant();
  if (!grant || grant.sessionId !== sessionId) {
    return NextResponse.json(toolErrorResult(
      'session_scope_invalid',
      'This tool call is not bound to the active Symon session scope.',
    ));
  }
  const scoped = scopeSymonToolArgs(grant, tool, args as Record<string, unknown>);
  if (!scoped.ok) return NextResponse.json(toolErrorResult(scoped.error, scoped.detail));
  if (body?.dryRun === true) {
    return NextResponse.json({
      ok: true,
      result: {
        state: 'scoped',
        scopedArgs: scoped.args,
        scopeVersion: grant.scopeVersion,
      },
    });
  }

  try {
    const outcome = await executeViaBridge(sessionId, callId, tool, scoped.args);
    return NextResponse.json(outcome);
  } catch (error) {
    // Defensive — executeViaBridge already returns structured results, but a
    // route MUST NOT throw. Hand the model a structured failure.
    const detail = error instanceof Error ? error.message : 'tool relay failed';
    console.warn(`${LOG} tool relay exception callId=${callId}: ${detail}`);
    return NextResponse.json(toolErrorResult('tool_failed', detail));
  }
}
