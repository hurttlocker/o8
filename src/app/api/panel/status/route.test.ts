import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/codebase-memory/indexer', () => ({ ensureCodebaseMemoryBootIndex: vi.fn() }));
vi.mock('@/lib/cortex/decay', () => ({ ensureDecayBootHook: vi.fn() }));
vi.mock('@/lib/cortex/proposer', () => ({ ensureProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/stack-signature', () => ({ ensureStackSignatureBoot: vi.fn() }));
vi.mock('@/lib/cortex/cross-repo-proposer', () => ({ ensureCrossRepoProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/external-merge-watcher', () => ({ ensureExternalMergeBootHook: vi.fn() }));
const { ensureShippedDarkAuditBootHookMock } = vi.hoisted(() => ({
  ensureShippedDarkAuditBootHookMock: vi.fn(),
}));
vi.mock('@/lib/operator/shipped-dark-scheduler', () => ({
  ensureShippedDarkAuditBootHook: ensureShippedDarkAuditBootHookMock,
  currentShippedDarkAuditStatus: () => ({
    schema: 'o8/shipped-dark-audit-status/v2',
    status: 'attention',
    checkedAt: '2026-08-27T12:05:00.000Z',
    currentRelease: '0.1.716',
    thresholdReleases: 3,
    checkedFlagCount: 14,
    attentionFlagCount: 1,
    flags: [{
      tomlKey: 'experimental.chat_enabled',
      codeDefault: false,
      operatorValue: false,
      operatorValueSource: 'default',
      landedRelease: '0.1.681',
      darkForReleases: 35,
      lifecycle: 'promotion-candidate',
      lifecycleRationale: null,
      needsAttention: true,
    }],
  }),
}));
vi.mock('@/lib/terminal/tmux', () => ({ persistentTerminalsEnabled: () => true }));
vi.mock('@/lib/terminal/persistence-health', () => ({
  currentPersistentTerminalHealth: () => ({
    schema: 'o8/persistent-terminal-health/v1',
    status: 'degraded',
    reason: 'tmux_unavailable',
    checkedAt: '2026-08-27T12:00:00.000Z',
  }),
}));

const { GET } = await import('./route');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/panel/status', () => {
  it('identifies the unauthenticated liveness responder as o8', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      product: 'o8',
      mode: 'local-cli',
      terminalPersistence: {
        status: 'degraded',
        reason: 'tmux_unavailable',
      },
      shippedDarkAudit: {
        status: 'attention',
        checkedFlagCount: 14,
        attentionFlagCount: 1,
        flags: [expect.objectContaining({
          tomlKey: 'experimental.chat_enabled',
          darkForReleases: 35,
          lifecycle: 'promotion-candidate',
          needsAttention: true,
        })],
      },
    });
    expect(ensureShippedDarkAuditBootHookMock).toHaveBeenCalledOnce();
  });

  it('reports the packaged build identity without reading a source checkout', async () => {
    vi.stubEnv('O8_BUILD_GIT_SHA', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
    vi.stubEnv('O8_PACKAGED_APP', '1');

    const response = await GET();
    expect(await response.json()).toMatchObject({
      buildGitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      buildMode: 'packaged',
    });
  });
});
