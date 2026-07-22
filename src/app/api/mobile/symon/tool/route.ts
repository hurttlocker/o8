export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import {
  parseSymonPendingConfirmation,
  symonToolTimeoutMs,
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
 * result cache keyed by sessionId + callId. Every execution has a bounded,
 * tool-aware timeout; expiry interrupts the exact native task before the relay
 * reports tool_timeout.
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
export function buildToolEval(
  sessionId: string,
  callId: string,
  tool: string,
  args: unknown,
  utterance?: string,
): string {
  const session = JSON.stringify(sessionId);
  const id = JSON.stringify(callId);
  const name = JSON.stringify(tool);
  const argsJson = JSON.stringify(args ?? {});
  const utteranceJson = JSON.stringify(utterance || undefined);
  return `(() => {
    const w = window;
    const A = w.__o8SymonAgent;
    const store = (w.__o8SymonToolCalls = w.__o8SymonToolCalls || {});
    const NOW = Date.now();
    const sessionId = ${session};
    const callId = ${id};
    const key = JSON.stringify([sessionId, callId]);
    for (const k in store) {
      const entry = store[k];
      if (!entry) continue;
      const terminalAt = entry.completedAt || entry.lastTouched || entry.startedAt || 0;
      const abandonedAt = entry.lastTouched || entry.startedAt || 0;
      if ((entry.done && NOW - terminalAt > 300000) || (k !== key && NOW - abandonedAt > 300000)) {
        delete store[k];
      }
    }
    if (!A || typeof A.invokeTool !== 'function') return JSON.stringify({ state: 'no_bridge' });
    let slot = store[key];
    if (!slot) {
      slot = store[key] = { startedAt: NOW, lastTouched: NOW, done: false, decisionSubmitted: false, tool: ${name} };
      Promise.resolve().then(() => A.invokeTool(${name}, ${argsJson}, { sessionId, callId }, ${utteranceJson})).then((result) => {
        const errored = !!(result && typeof result === 'object' && 'error' in result);
        store[key] = Object.assign(store[key] || {}, { done: true, completedAt: Date.now(), ok: !errored, result: result });
      }).catch((e) => {
        store[key] = Object.assign(store[key] || {}, { done: true, completedAt: Date.now(), ok: false, result: { error: 'tool_failed', detail: String((e && e.message) || e) } });
      });
    }
    if (!slot.done) slot.lastTouched = NOW;
    if (slot.tool !== ${name}) return JSON.stringify({ state: 'call_mismatch' });
    if (slot.done) return JSON.stringify({ state: 'done', ok: slot.ok, result: slot.result });
    if (Array.isArray(A.pendingConfirmations)) {
      const hit = A.pendingConfirmations.find((c) => c && c.sessionId === sessionId && c.callId === callId && c.tool === ${name});
      if (hit && hit.confirmationId !== slot.confirmationId) {
        slot.confirmation = hit;
        slot.confirmationId = hit.confirmationId;
        slot.decisionSubmitted = false;
        delete slot.confirmResolution;
      }
    }
    if (slot.confirmation && !slot.decisionSubmitted) {
      return JSON.stringify({ state: 'needs_confirmation', confirmation: slot.confirmation });
    }
    return JSON.stringify({ state: 'pending' });
  })()`;
}

export function buildToolInterruptEval(sessionId: string, callId: string): string {
  const session = JSON.stringify(sessionId);
  const id = JSON.stringify(callId);
  return `(() => {
    const w = window;
    const A = w.__o8SymonAgent;
    if (!A || typeof A.interruptTool !== 'function') return JSON.stringify({ state: 'no_bridge' });
    const sessionId = ${session};
    const callId = ${id};
    const key = JSON.stringify([sessionId, callId]);
    const interrupts = (w.__o8SymonToolInterrupts = w.__o8SymonToolInterrupts || {});
    const NOW = Date.now();
    for (const interruptKey in interrupts) {
      const candidate = interrupts[interruptKey];
      if (candidate && NOW - (candidate.startedAt || 0) > 300000) delete interrupts[interruptKey];
    }
    let entry = interrupts[key];
    if (!entry) {
      entry = interrupts[key] = { startedAt: NOW, done: false };
      Promise.resolve().then(() => A.interruptTool({ sessionId, callId })).then((active) => {
        interrupts[key] = Object.assign(interrupts[key] || {}, { done: true, active: Boolean(active) });
      }).catch((error) => {
        interrupts[key] = Object.assign(interrupts[key] || {}, {
          done: true,
          error: String((error && error.message) || error),
        });
      });
    }
    if (entry.done && entry.error) {
      delete interrupts[key];
      return JSON.stringify({ state: 'error', detail: entry.error });
    }
    if (entry.done) return JSON.stringify({ state: 'done', active: entry.active });
    return JSON.stringify({ state: 'pending' });
  })()`;
}

type BridgeInterruptResult = { delivered: true; wasActive: boolean } | { delivered: false };

async function interruptViaBridge(sessionId: string, callId: string): Promise<BridgeInterruptResult> {
  const client = webviewClient();
  const code = buildToolInterruptEval(sessionId, callId);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const { result } = await client.evalJs(code);
      const parsed = JSON.parse(result) as { state?: string; active?: boolean };
      if (parsed.state === 'done') return { delivered: true, wasActive: Boolean(parsed.active) };
    } catch {
      // The app/webview may be between mounts. Retry within the bounded window.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { delivered: false };
}

async function executeViaBridge(
  sessionId: string,
  callId: string,
  tool: string,
  args: unknown,
  utterance?: string,
): Promise<SymonToolRelayResult> {
  const client = webviewClient();
  const code = buildToolEval(sessionId, callId, tool, args, utterance);
  const deadline = Date.now() + symonToolTimeoutMs(tool);
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
  const interrupted = await interruptViaBridge(sessionId, callId);
  return interrupted.delivered
    ? toolTimeoutResult()
    : toolErrorResult(
      'interrupt_delivery_failed',
      'The tool exceeded its execution budget, but native cancellation could not be delivered; its outcome is unknown.',
    );
}

export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const callId = typeof body?.callId === 'string' ? body.callId : '';
  if (!sessionId || !callId) {
    return NextResponse.json({ ok: false, error: 'bad_request' });
  }
  const interrupted = await interruptViaBridge(sessionId, callId);
  return interrupted.delivered
    ? NextResponse.json({ ok: true, delivered: true, wasActive: interrupted.wasActive })
    : NextResponse.json(
      { ok: false, delivered: false, error: 'interrupt_delivery_failed' },
      { status: 503 },
    );
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as
    | {
      sessionId?: unknown;
      callId?: unknown;
      tool?: unknown;
      args?: unknown;
      utterance?: unknown;
      dryRun?: unknown;
    }
    | null;

  const callId = typeof body?.callId === 'string' ? body.callId : '';
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const args = body?.args !== undefined && body?.args !== null && typeof body.args === 'object' ? body.args : {};
  const utterance = typeof body?.utterance === 'string'
    ? body.utterance.trim().slice(0, 8_000)
    : '';

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
    const outcome = await executeViaBridge(
      sessionId,
      callId,
      tool,
      scoped.args,
      utterance || undefined,
    );
    return NextResponse.json(outcome);
  } catch (error) {
    // Defensive — executeViaBridge already returns structured results, but a
    // route MUST NOT throw. Hand the model a structured failure.
    const detail = error instanceof Error ? error.message : 'tool relay failed';
    console.warn(`${LOG} tool relay exception callId=${callId}: ${detail}`);
    return NextResponse.json(toolErrorResult('tool_failed', detail));
  }
}
