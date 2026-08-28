import 'server-only';

import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import {
  buildSymonTextPlannerInfoEval,
  buildSymonTextInterruptEval,
  buildSymonTextTurnEval,
  type SymonTextPlannerSelection,
} from '@/lib/mobile/symon-text-eval';

const POLL_INTERVAL_MS = 150;
const BRIDGE_TIMEOUT_MS = 5_000;

export interface SymonTextPlannerInfo {
  available?: boolean;
  engine?: 'claude' | 'codex';
  model?: string;
  effort?: string;
  tools?: Array<Record<string, unknown>>;
  detail?: string;
}

export interface SymonTextTurnBridgeResult {
  state?: 'pending' | 'done' | 'needs_confirmation' | 'error' | 'call_mismatch' | 'no_bridge';
  result?: { status?: 'done' | 'interrupted'; text?: string; activeMachine?: unknown };
  confirmation?: unknown;
  detail?: string;
  error?: string;
}

function webviewClient(): O8WebviewClient {
  const global = globalThis as { __o8SymonTextClient?: O8WebviewClient };
  global.__o8SymonTextClient ??= new O8WebviewClient();
  return global.__o8SymonTextClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readSymonTextPlannerInfo(
  selection?: SymonTextPlannerSelection,
): Promise<SymonTextPlannerInfo> {
  const code = buildSymonTextPlannerInfoEval(selection);
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { result } = await webviewClient().evalJs(code);
    const parsed = JSON.parse(result) as { state?: string; info?: SymonTextPlannerInfo; detail?: string };
    if (parsed.state === 'no_bridge') throw new Error('Symon text planner bridge is not mounted.');
    if (parsed.state === 'error') throw new Error(parsed.detail || 'Symon text planner bridge failed.');
    if (parsed.state === 'done' && parsed.info) return parsed.info;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Symon text planner bridge timed out.');
}

export async function pollSymonTextTurn(
  input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    planner: SymonTextPlannerSelection;
  },
  windowMs: number = 3_000,
): Promise<SymonTextTurnBridgeResult> {
  const code = buildSymonTextTurnEval(
    input.sessionId,
    input.turnId,
    input.prompt,
    input.planner,
  );
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const { result } = await webviewClient().evalJs(code);
    const parsed = JSON.parse(result) as SymonTextTurnBridgeResult;
    if (parsed.state !== 'pending') return parsed;
    await sleep(POLL_INTERVAL_MS);
  }
  return { state: 'pending' };
}

export async function pollSymonTextInterrupt(
  sessionId: string,
  turnId: string,
  windowMs: number = 3_000,
): Promise<Record<string, unknown>> {
  const code = buildSymonTextInterruptEval(sessionId, turnId);
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const { result } = await webviewClient().evalJs(code);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.state !== 'pending') return parsed;
    await sleep(POLL_INTERVAL_MS);
  }
  return { state: 'pending' };
}
