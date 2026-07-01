/**
 * effort→worker END-TO-END (Commit 3). Proves createMission threads
 * requestedEffort through routing onto the persisted packet's
 * workerRouting.selectedEffort — codex honors it, gemini is a per-runtime no-op,
 * and unset stays null (parity). Touches the orchestrator store, so it runs as a
 * tsx smoke against a fresh data dir (not vitest).
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/worker-effort-e2e-smoke.ts
 */

import assert from 'node:assert';

import { createMission } from '@/lib/orchestrator/operator-mission-service';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import type { WorkerRouting } from '@/lib/orchestrator/types';

async function dispatch(over: Record<string, unknown>): Promise<WorkerRouting> {
  await createMission({
    issues: [{ number: 90001, title: 'x', body: '', url: '' }],
    repoPath: process.cwd(), runtime: 'codex', constraints: '', ...over,
  } as never);
  const routing = currentMissionState().packets[0]?.workerRouting;
  if (!routing) throw new Error('mission produced no packet routing');
  return routing;
}

async function main(): Promise<void> {
  const codex = await dispatch({ requestedRuntime: 'codex', requestedEffort: 'high' });
  assert.strictEqual(codex.selectedEffort, 'high', `codex/high → ${codex.selectedEffort}`);
  assert.strictEqual(codex.requestedEffort, 'high');

  const parity = await dispatch({ requestedRuntime: 'codex' });
  assert.strictEqual(parity.selectedEffort, null, `no effort must be null (parity) → ${parity.selectedEffort}`);

  const gemini = await dispatch({ requestedRuntime: 'gemini', requestedEffort: 'high' });
  assert.strictEqual(gemini.selectedEffort, null, `gemini no-op → ${gemini.selectedEffort}`);
  assert.strictEqual(gemini.requestedEffort, 'high', 'the request is still recorded');

  console.log('[worker-effort-e2e-smoke] PASS — createMission threads effort → packet routing (codex honors, gemini no-op, unset=null)');
}

void main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
