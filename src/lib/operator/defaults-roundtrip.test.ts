import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-operator-defaults-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getOperatorDefaults, updateOperatorDefaults } = await import('./defaults');

/**
 * Evaporation guard: updateOperatorDefaults copies each field from the update
 * into the stored file with a per-field block — a field that is validated by
 * the API route but missing its copy block here silently round-trips to the
 * old value (bit reviewerBackend on 2026-07-07: the settings UI accepted the
 * click, the POST returned 200, and nothing persisted). Every UI-settable
 * knob gets a non-default value below; add new knobs here when adding
 * them to the writer.
 */
const NON_DEFAULT_UPDATE = {
  parallelCap: 3,
  overlapGate: 'strict',
  healBotEnabled: false,
  supervisorAutoEscalate: true,
  thinkingEffort: 'low',
  promptCachingEnabled: false,
  orchestratorModel: 'claude-opus-4-8',
  defaultDispatchRuntime: 'claude-code',
  workerRuntimes: ['claude-code', 'codex'] as Array<'claude-code' | 'codex'>,
  codexWorkerEffort: 'xhigh',
  claudeWorkerEffort: 'max',
  defaultDispatchModel: 'some-model',
  experimentalOpencode: true,
  experimentalGemini: true,
  experimentalChat: true,
  experimentalCanvas: true,
  nativeBrowserView: false,
  inAppOrchestratorEnabled: false,
  brainUseClaudeCli: false,
  workersUseBrain: 'off',
  orchestratorBackend: 'collide',
  reviewerBackend: 'codex',
  packetExplainerEnabled: false,
  quizGateEnabled: true,
  buyinDocEnabled: true,
  updateAutoApply: 'idle',
  collideAggregator: 'claude',
  productTelemetryEnabled: true,
  telemetryOptIn: true,
  telemetryIngestUrl: 'https://telemetry.example/ingest',
  crashReportsEnabled: false,
  branchPrefix: 'wip',
  commitAttributionEnabled: true,
  prLinkDestination: 'browser',
  worktreeMaxCount: 12,
  worktreeMaxTotalGb: 8,
} as const;

describe('updateOperatorDefaults round-trip', () => {
  it('migrates the legacy autoApplyUpdates value to updateAutoApply', async () => {
    writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({
      autoApplyUpdates: 'when-idle',
    }));
    expect((await getOperatorDefaults()).values.updateAutoApply).toBe('idle');
  });

  it('persists every settable field (no silent evaporation)', async () => {
    const result = await updateOperatorDefaults({ ...NON_DEFAULT_UPDATE });
    for (const [field, expected] of Object.entries(NON_DEFAULT_UPDATE)) {
      expect(result.values[field as keyof typeof result.values], `field ${field} evaporated in updateOperatorDefaults`).toEqual(expected);
    }
  });

  it('reviewerBackend survives a follow-up unrelated write', async () => {
    await updateOperatorDefaults({ reviewerBackend: 'codex' });
    const after = await updateOperatorDefaults({ parallelCap: 5 });
    expect(after.values.reviewerBackend).toBe('codex');
  });

  it('subscriptionProfile persists and flips the effective house defaults', async () => {
    const after = await updateOperatorDefaults({ subscriptionProfile: 'claude-only' });
    expect(after.values.subscriptionProfile).toBe('claude-only');
    expect(after.values.orchestratorBackend).toBe('claude');
    expect(after.values.defaultDispatchRuntime).toBe('claude-code');
    expect(after.values.reviewerBackend).toBe('claude');
  });
});
