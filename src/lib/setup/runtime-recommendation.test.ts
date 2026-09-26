import { describe, expect, it } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import { recommendRuntimeSetup, visibleRuntimeInventory } from './runtime-recommendation';

const inventory = [
  { id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: '', fix: '' },
  { id: 'claude-code', label: 'Claude Code', available: true, unavailableReason: null, detail: '', fix: '' },
  { id: 'gemini', label: 'Gemini', available: false, unavailableReason: 'needs_auth', detail: '', fix: 'Sign in' },
  { id: 'opencode', label: 'OpenCode', available: false, unavailableReason: 'not_installed', detail: '', fix: 'Install' },
] as const;
const activity = { codex: 3, claude: 8, complete: true };

describe('detected runtime recommendation', () => {
  it('uses seven-day activity for a fresh install and economical workers', () => {
    const setup = recommendRuntimeSetup({ inventory, activity });
    expect(setup.backend).toBe('claude');
    expect(setup.workerRuntimes).toEqual(['claude-code']);
    expect(setup.workerModel).toBe(MODEL_IDS.claudeWorkerDefault);
    expect(setup.reason).toContain('past seven days');
  });

  it('keeps explicit choices even when another runtime was used more', () => {
    const setup = recommendRuntimeSetup({ inventory, activity, values: {
      orchestratorBackend: 'codex', orchestratorModel: MODEL_IDS.codexDefault,
      defaultDispatchRuntime: 'codex', defaultDispatchModel: MODEL_IDS.codexCliDefault,
      workerRuntimes: ['codex'],
    }, sources: { orchestratorBackend: 'file', orchestratorModel: 'file', defaultDispatchModel: 'file', workerRuntimes: 'file', defaultDispatchRuntime: 'file' } });
    expect(setup.backend).toBe('codex');
    expect(setup.workerModel).toBe(MODEL_IDS.codexCliDefault);
    expect(setup.reason).toContain('saved');
  });

  it('keeps the saved default worker when the pool was ordered differently', () => {
    const setup = recommendRuntimeSetup({ inventory, activity, values: {
      defaultDispatchRuntime: 'codex', workerRuntimes: ['claude-code', 'codex'],
    }, sources: { defaultDispatchRuntime: 'file', workerRuntimes: 'file' } });
    expect(setup.workerRuntimes).toEqual(['codex', 'claude-code']);
    expect(setup.workerModel).toBe(MODEL_IDS.codexWorkerDefault);
  });

  it('does not infer a preference from a partial or tied scan', () => {
    for (const evidence of [{ ...activity, complete: false }, { codex: 0, claude: 0, complete: true }]) {
      const setup = recommendRuntimeSetup({ inventory, activity: evidence });
      expect(setup.backend).toBe('codex');
      expect(setup.reason).not.toContain('more');
    }
  });

  it('chooses the only ready primary and leaves a no-primary setup unselected', () => {
    expect(recommendRuntimeSetup({ inventory: inventory.slice(1), activity }).backend).toBe('claude');
    expect(recommendRuntimeSetup({ inventory: inventory.slice(2), activity }).backend).toBeNull();
  });

  it('shows installed tools needing login, hides missing tools, and preserves a selected missing tool', () => {
    expect(visibleRuntimeInventory(inventory).map((item) => item.id)).toEqual(['codex', 'claude-code', 'gemini']);
    expect(visibleRuntimeInventory(inventory, ['opencode']).map((item) => item.id)).toContain('opencode');
  });
});
