import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defaults: { values: { workerRuntimes: ['claude-code'], defaultDispatchRuntime: 'claude-code', defaultDispatchModel: '', workerExecutionCarrier: null, subscriptionProfile: 'both' }, sources: { workerRuntimes: 'file' } },
  native: vi.fn(), carrier: vi.fn(),
  selection: { source: 'codex-subscription', model: 'carrier-model' },
}));
vi.mock('@/lib/operator/defaults', () => ({ getOperatorDefaultsSync: () => mocks.defaults }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: mocks.native }));
vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({ readCodexSubscriptionProxyModels: mocks.carrier }));
vi.mock('@/lib/claude-code/worker-profile', () => ({ resolveClaudeCodeWorkerSelection: () => mocks.selection }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ getDispatchableRuntimeAvailability: async () => [
  { id: 'claude-code', available: true }, { id: 'codex', available: true },
] }));
import { getWorkerCatalog, workerModelCatalog } from './worker-catalog';

beforeEach(() => { vi.clearAllMocks(); mocks.selection.source = 'codex-subscription'; });
describe('configured worker discovery', () => {
  it('only advertises the enabled pool even when another runtime is ready', async () => {
    const result = await getWorkerCatalog('/repo');
    expect(result.workers.map(worker => worker.runtime)).toEqual(['claude-code']);
    await expect(getWorkerCatalog('/repo', 'codex')).rejects.toThrow('configured worker pool');
  });
  it('uses the configured carrier model list without requiring native Codex', async () => {
    mocks.native.mockRejectedValue(new Error('Codex is absent'));
    mocks.carrier.mockResolvedValue(['carrier-model', 'second-carrier-model']);
    const result = await workerModelCatalog('claude-code', '/repo');
    expect(result.models.map(model => model.id)).toEqual(['carrier-model', 'second-carrier-model']);
    expect(result.source).toBe('configured-carrier-model-list');
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it('advertises only the configured model when the carrier is not running', async () => {
    mocks.carrier.mockResolvedValue(null);
    const result = await workerModelCatalog('claude-code', '/repo');
    expect(result.models.map(model => model.id)).toEqual(['carrier-model']);
    expect(result.source).toBe('configured-carrier-model');
    expect(mocks.native).not.toHaveBeenCalled();
  });
});
