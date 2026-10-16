import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  configured: 'codex' as string,
  lane: { packetId: 'pkt-1', model: null as string | null } as { packetId: string | null; model: string | null } | null,
  assignedModel: null as string | null,
}));
vi.mock('./orchestrator-backends/active-backend', () => ({ resolveReviewerBackendId: () => state.configured }));
vi.mock('./registry', () => ({ getLane: () => state.lane }));
vi.mock('@/lib/orchestrator/mission-registry', () => ({
  findMissionRegistryEntryByPacketId: () => ({ mission: { packets: [{ id: 'pkt-1', assignedModel: state.assignedModel }] } }),
}));

const { resolveReviewRoute } = await import('./review-route');

afterEach(() => {
  vi.unstubAllEnvs();
  state.configured = 'codex';
  state.lane = { packetId: 'pkt-1', model: null };
  state.assignedModel = null;
});

const missingCli = () => {
  vi.stubEnv('O8_CODEX_BIN', '/nonexistent/o8-test/codex');
  vi.stubEnv('O8_CLAUDE_CODE_BIN', '/nonexistent/o8-test/claude');
};

describe('resolveReviewRoute (#3742)', () => {
  it('runs the review on managed Pi when the CLI is missing and the packet is not on OpenRouter', () => {
    missingCli();
    state.assignedModel = 'gpt-6.1-sol';
    expect(resolveReviewRoute('lane-1')).toEqual({
      backend: 'pi', model: undefined, reason: "The codex CLI is not installed, so the review runs on o8's Pi.",
    });
  });

  it('keeps the packet OpenRouter model, from the packet or the lane, when the CLI is missing', () => {
    missingCli();
    state.assignedModel = 'openrouter/deepseek/deepseek-v4.1-flash';
    expect(resolveReviewRoute('lane-1')).toMatchObject({ backend: 'pi', model: 'openrouter/deepseek/deepseek-v4.1-flash' });
    state.assignedModel = null;
    state.lane = { packetId: 'pkt-1', model: 'openrouter/z/model' };
    expect(resolveReviewRoute('lane-1')).toMatchObject({ backend: 'pi', model: 'openrouter/z/model' });
  });

  it('keeps an installed CLI reviewer and a configured Pi reviewer as they are', () => {
    vi.stubEnv('O8_CODEX_BIN', process.execPath);
    state.assignedModel = 'openrouter/deepseek/deepseek-v4.1-flash';
    expect(resolveReviewRoute('lane-1')).toEqual({ backend: 'codex' });
    state.configured = 'pi';
    expect(resolveReviewRoute('lane-1')).toEqual({ backend: 'pi', model: 'openrouter/deepseek/deepseek-v4.1-flash' });
    state.configured = 'openclaw';
    expect(resolveReviewRoute('lane-1')).toEqual({ backend: 'openclaw' });
  });
});
