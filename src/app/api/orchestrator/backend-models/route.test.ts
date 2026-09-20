import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePanelAuth: vi.fn(),
  resolveAcpLaunch: vi.fn(),
  isOrchestratorBackendId: vi.fn(),
  probeAcpModels: vi.fn(),
  getOpenRouterModelMetadata: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: mocks.requirePanelAuth }));
vi.mock('@/lib/lane/orchestrator-backends/acp', () => ({ resolveAcpLaunch: mocks.resolveAcpLaunch }));
vi.mock('@/lib/lane/orchestrator-backends/types', () => ({ isOrchestratorBackendId: mocks.isOrchestratorBackendId }));
vi.mock('@/lib/orchestrator/acp-model-probe', () => ({ probeAcpModels: mocks.probeAcpModels }));
vi.mock('@/lib/orchestrator/openrouter-model-metadata', () => ({ getOpenRouterModelMetadata: mocks.getOpenRouterModelMetadata }));

import { GET } from './route';

describe('GET /api/orchestrator/backend-models', () => {
  beforeEach(() => {
    mocks.requirePanelAuth.mockReset().mockReturnValue(null);
    mocks.resolveAcpLaunch.mockReset().mockReturnValue({ command: 'opencode', args: [] });
    mocks.isOrchestratorBackendId.mockReset().mockReturnValue(true);
    mocks.probeAcpModels.mockReset().mockResolvedValue({
      models: [
        { value: 'openrouter/acme/alpha' },
        { value: 'openrouter/acme/beta' },
        { value: 'openrouter/acme/alpha/high' },
      ],
      currentModel: 'openrouter/acme/alpha/high',
      probedAt: 1,
      source: 'probe',
    });
    mocks.getOpenRouterModelMetadata.mockReset();
  });

  it('joins sorted public metadata only to exact runtime ids while preserving effort variants', async () => {
    mocks.getOpenRouterModelMetadata.mockResolvedValue(new Map([
      ['openrouter/acme/alpha', { rank: 1, label: 'Alpha', free: true, compatible: true }],
      ['openrouter/acme/beta', { rank: 0, label: 'Beta', free: false, compatible: true }],
    ]));
    const response = await GET(new NextRequest('http://localhost/api/orchestrator/backend-models?backend=opencode&sort=newest'));
    const body = await response.json();

    expect(mocks.getOpenRouterModelMetadata).toHaveBeenCalledWith('newest');
    expect(body.rankingAvailable).toBe(true);
    expect(body.sort).toBe('newest');
    expect(body.groups[0].models.map((model: { id: string }) => model.id)).toEqual([
      'openrouter/acme/beta',
      'openrouter/acme/alpha',
    ]);
    expect(body.groups[0].models[1]).toMatchObject({
      id: 'openrouter/acme/alpha',
      metadata: { free: true, compatible: true },
      efforts: [{ effort: 'high', id: 'openrouter/acme/alpha/high' }],
    });
  });

  it('serves the agent catalogue without a rank or free claim when public metadata is unavailable', async () => {
    mocks.getOpenRouterModelMetadata.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost/api/orchestrator/backend-models?backend=opencode'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rankingAvailable).toBe(false);
    expect(body.sort).toBeUndefined();
    expect(body.groups[0].models.every((model: { metadata?: unknown }) => model.metadata === undefined)).toBe(true);
  });
});
