/**
 * Orchestrator backend setting — derivation test (live).
 *
 * Proves resolveOrchestratorBackendId() honors the new `orchestratorBackend`
 * operator setting:
 *   - 'auto' (default) → BYTE-IDENTICAL to the legacy inAppOrchestratorEnabled
 *     derivation (toggle ON → 'claude', OFF → 'codex');
 *   - an explicit id ('codex' | 'claude' | 'openclaw') → passthrough, overriding
 *     the toggle. This is how OpenClaw becomes selectable from the desktop.
 *
 * Controlled via env (O8_ORCHESTRATOR_BACKEND / O8_IN_APP_ORCHESTRATOR_ENABLED),
 * which take precedence over file/fallback; a temp data dir keeps it hermetic.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/orchestrator-backend-setting-smoke.ts
 */

import assert from 'node:assert';

import './require-temp-data-dir';
import { resolveOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/registry';
import { resolveInAppOrchestratorEnabledSync } from '@/lib/operator/defaults';

function setEnv(backend: string | undefined, inApp: string | undefined): void {
  if (backend === undefined) delete process.env.O8_ORCHESTRATOR_BACKEND;
  else process.env.O8_ORCHESTRATOR_BACKEND = backend;
  if (inApp === undefined) delete process.env.O8_IN_APP_ORCHESTRATOR_ENABLED;
  else process.env.O8_IN_APP_ORCHESTRATOR_ENABLED = inApp;
}

/** The exact pre-setting derivation — the byte-identical contract for 'auto'. */
function legacy(): 'claude' | 'codex' {
  return resolveInAppOrchestratorEnabledSync() ? 'claude' : 'codex';
}

function main(): void {
  // ── 'auto' (default): byte-identical to the legacy derivation ──
  // Default fallback: orchestratorBackend 'auto', inAppOrchestratorEnabled true.
  setEnv(undefined, undefined);
  assert.strictEqual(resolveOrchestratorBackendId(), 'claude', 'default (auto + inApp default true) → claude');
  assert.strictEqual(resolveOrchestratorBackendId(), legacy(), 'default is byte-identical to legacy');

  setEnv('auto', '1');
  assert.strictEqual(resolveOrchestratorBackendId(), 'claude', 'auto + toggle ON → claude');
  assert.strictEqual(resolveOrchestratorBackendId(), legacy(), 'auto+ON byte-identical to legacy');

  setEnv('auto', '0');
  assert.strictEqual(resolveOrchestratorBackendId(), 'codex', 'auto + toggle OFF → codex');
  assert.strictEqual(resolveOrchestratorBackendId(), legacy(), 'auto+OFF byte-identical to legacy');

  // ── explicit id: passthrough, overrides the toggle ──
  setEnv('openclaw', '1');
  assert.strictEqual(resolveOrchestratorBackendId(), 'openclaw', 'explicit openclaw → openclaw (toggle ignored)');
  setEnv('openclaw', '0');
  assert.strictEqual(resolveOrchestratorBackendId(), 'openclaw', 'explicit openclaw → openclaw regardless of toggle');

  setEnv('codex', '1');
  assert.strictEqual(resolveOrchestratorBackendId(), 'codex', 'explicit codex overrides toggle ON');
  setEnv('claude', '0');
  assert.strictEqual(resolveOrchestratorBackendId(), 'claude', 'explicit claude overrides toggle OFF');

  // An explicit id is NOT the legacy derivation (proves the new path is live).
  setEnv('openclaw', '1');
  assert.notStrictEqual(resolveOrchestratorBackendId(), legacy(), 'explicit openclaw diverges from legacy');

  console.log('[orchestrator-backend-setting-smoke] PASS — auto = legacy (byte-identical); explicit = passthrough');
}

main();
