import { beforeEach, describe, expect, it, vi } from 'vitest';

const profileState = vi.hoisted(() => ({
  source: 'native' as 'native' | 'openrouter' | 'codex-subscription',
  model: null as string | null,
  codexModel: null as string | null,
  openRouterKey: null as string | null,
}));
const ensureProxyMock = vi.hoisted(() => vi.fn(async () => ({
  baseUrl: 'http://127.0.0.1:8317',
  clientToken: 'local-carrier-token',
  models: ['gpt-5.6-sol'],
})));
const ensureConfigDirMock = vi.hoisted(() => vi.fn(async (sessionDir: string) => `${sessionDir}/claude-code-codex-config`));

vi.mock('@/lib/claude-code/worker-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude-code/worker-profile')>();
  return {
    ...actual,
    readClaudeCodeWorkerProfileSync: () => ({
      source: profileState.source,
      model: profileState.model,
      codexModel: profileState.codexModel,
    }),
    selectedClaudeCodeWorkerModelSync: () => profileState.source === 'codex-subscription'
      ? profileState.codexModel
      : profileState.model,
    resolveClaudeCodeWorkerGatewayKey: async () => profileState.openRouterKey,
  };
});

vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({
  ensureCodexSubscriptionProxyReady: ensureProxyMock,
  ensureCodexSubscriptionClaudeConfigDir: ensureConfigDirMock,
}));

const { resolveClaudeHarnessCarrier } = await import('./claude-harness-carrier');

describe('Claude Code orchestrator carrier', () => {
  beforeEach(() => {
    profileState.source = 'native';
    profileState.model = null;
    profileState.codexModel = null;
    profileState.openRouterKey = null;
    ensureProxyMock.mockClear();
    ensureConfigDirMock.mockClear();
  });

  it('leaves the native Claude Code orchestrator unchanged', async () => {
    await expect(resolveClaudeHarnessCarrier({
      requestedModel: 'claude-opus-4-8',
      sessionDir: '/tmp/native-session',
    })).resolves.toMatchObject({ source: 'native', model: 'claude-opus-4-8', spawnEnv: {} });
  });

  it('isolates a Codex-backed orchestrator while retaining the full harness', async () => {
    profileState.source = 'codex-subscription';
    profileState.codexModel = 'gpt-5.6-sol';
    const carrier = await resolveClaudeHarnessCarrier({
      requestedModel: 'claude-opus-4-8',
      sessionDir: '/tmp/thread-one',
    });

    expect(carrier).toMatchObject({
      source: 'codex-subscription',
      model: 'gpt-5.6-sol',
      spawnEnv: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
        ANTHROPIC_AUTH_TOKEN: 'local-carrier-token',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CONFIG_DIR: '/tmp/thread-one/claude-code-codex-config',
      },
    });
    expect(carrier.spawnEnv).not.toHaveProperty('CLAUDE_CODE_SIMPLE');
    expect(carrier.fingerprint).not.toContain('local-carrier-token');
  });
});
