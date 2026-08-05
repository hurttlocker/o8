/**
 * ACP client (Step 3b) — full-turn against a mock peer + live hermes acp handshake.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/acp-client-smoke.ts
 *
 * Part A drives the real AcpClient through initialize → session/new → session/prompt
 * against a scripted mock ACP agent and asserts the streamed OrchestratorEvents.
 * Part B does a live initialize + session/new against the installed `hermes acp`
 * (no model turn — that needs the operator's provider) to prove the client speaks
 * the REAL protocol, not just the spec.
 */

import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AcpClient, mapStopReason, type AcpInitializeResult } from '@/lib/acp/client';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp-agent.mjs');

async function partA(): Promise<void> {
  const events: OrchestratorEvent[] = [];
  const client = new AcpClient({ command: process.execPath, args: [MOCK], onEvent: (e) => events.push(e) });
  try {
    const init = await client.initialize();
    assert.strictEqual(init.protocolVersion, 1, 'mock initialize → protocolVersion 1');

    const sessionId = await client.newSession(process.cwd(), []);
    assert.strictEqual(sessionId, 'mock-sess', 'mock session/new → sessionId');

    const stop = await client.prompt(sessionId, 'do it');
    assert.strictEqual(stop, 'end_turn', 'prompt resolves with stopReason');
    events.push(mapStopReason(stop, sessionId));

    const types = events.map((e) => e.type);
    assert.deepStrictEqual(types, ['thinking', 'tool_use', 'tool_result', 'text', 'text', 'done'], 'event stream order (usage_update ignored)');
    assert.strictEqual((events[0] as { text: string }).text, 'planning', 'thinking text');
    assert.strictEqual((events[1] as { name: string }).name, 'Read file', 'tool_use name');
    assert.strictEqual((events[2] as { output: string }).output, 'file body', 'tool_result output');
    assert.strictEqual((events[3] as { text: string }).text + (events[4] as { text: string }).text, 'Done. Bye.', 'text chunks concatenate');
    assert.deepStrictEqual(events[5], { type: 'done', sessionId: 'mock-sess', cost: null }, 'done event');
    console.log('[acp-client-smoke] Part A (mock turn) PASS');
  } finally {
    client.kill();
  }
}

function hermesAvailable(): boolean {
  try {
    execSync('hermes acp --check', { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function partB(): Promise<void> {
  if (!hermesAvailable()) {
    console.log('[acp-client-smoke] Part B SKIPPED — hermes acp --check not OK on this machine');
    return;
  }
  const client = new AcpClient({ command: 'hermes', args: ['acp', '--accept-hooks'] });
  try {
    const init: AcpInitializeResult = await client.initialize();
    assert.strictEqual(init.protocolVersion, 1, 'live hermes initialize → protocolVersion 1');
    assert(init.agentInfo?.name?.includes('hermes'), 'live hermes agentInfo.name is hermes');

    const { sessionId, configOptions } = await client.newSession(process.cwd(), []);
    assert(typeof sessionId === 'string' && sessionId.length > 0, 'live hermes session/new → sessionId');
    assert(Array.isArray(configOptions), 'live hermes session/new → configOptions array (may be empty)');
    console.log(`[acp-client-smoke] Part B (live hermes handshake) PASS — agent=${init.agentInfo?.name} v${init.agentInfo?.version}, session=${sessionId.slice(0, 8)}…, configOptions=${configOptions.length}`);
  } finally {
    client.kill();
  }
}

async function main(): Promise<void> {
  await partA();
  await partB();
  console.log('[acp-client-smoke] PASS');
}

void main().catch((err) => {
  console.error('[acp-client-smoke] FAIL', err);
  process.exit(1);
});
