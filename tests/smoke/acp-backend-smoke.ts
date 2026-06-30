/**
 * ACP backend (Step 3c) — implements the OrchestratorBackend contract; a turn
 * streams events. Drives makeAcpBackend against the mock ACP agent (no provider).
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/acp-backend-smoke.ts
 */

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeAcpBackend } from '@/lib/lane/orchestrator-backends/acp';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp-agent.mjs');

async function main(): Promise<void> {
  const backend = makeAcpBackend({
    id: 'acp',
    label: 'ACP-test',
    resolveLaunch: () => ({ command: process.execPath, args: [MOCK] }),
  });

  assert.strictEqual(backend.id, 'acp', 'backend id');

  // peek before ensure → null (no session yet).
  assert.strictEqual(backend.peekSession('/repo', undefined, 'thread-1'), null, 'peek before ensure is null');

  const info = backend.ensureSession('/repo', undefined, 'thread-1');
  assert(info.sessionName.includes('/repo'), 'ensureSession returns a session name');
  assert.strictEqual(info.status, 'ready', 'session starts ready');
  assert(backend.peekSession('/repo', undefined, 'thread-1') !== null, 'peek after ensure is non-null');

  const events: OrchestratorEvent[] = [];
  await backend.sendTurn('/repo', 'do it', (e) => events.push(e), { threadId: 'thread-1' });

  const types = events.map((e) => e.type);
  assert.deepStrictEqual(types, ['thinking', 'tool_use', 'tool_result', 'text', 'text', 'done'], 'turn streams the mapped event sequence');
  assert.deepStrictEqual(events[events.length - 1], { type: 'done', sessionId: 'mock-sess', cost: null }, 'turn ends with done');

  // Session is reusable for a second turn (same subprocess / ACP sessionId).
  const events2: OrchestratorEvent[] = [];
  await backend.sendTurn('/repo', 'again', (e) => events2.push(e), { threadId: 'thread-1' });
  assert(events2.some((e) => e.type === 'done'), 'second turn on the reused session completes');
  assert.strictEqual(backend.peekSession('/repo', undefined, 'thread-1')?.status, 'ready', 'session ready after turns');

  console.log('[acp-backend-smoke] PASS — contract implemented; turn streams events; session reused');
}

// Watchdog: the backend keeps session subprocesses alive, so exit explicitly.
const watchdog = setTimeout(() => {
  console.error('[acp-backend-smoke] FAIL — timed out');
  process.exit(2);
}, 15000);
watchdog.unref();

void main().then(() => process.exit(0)).catch((err) => {
  console.error('[acp-backend-smoke] FAIL', err);
  process.exit(1);
});
