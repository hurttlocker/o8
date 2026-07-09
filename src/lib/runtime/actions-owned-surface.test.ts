import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  continueOwnedCodexSession: vi.fn(),
}));

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));

vi.mock('@/lib/codex/owned', () => ({
  continueOwnedCodexSession: mocks.continueOwnedCodexSession,
  interruptOwnedCodexSession: vi.fn(),
  setOwnedCodexReviewDisposition: vi.fn(),
}));

vi.mock('@/lib/runtime/interrupt-escalation', () => ({
  escalateInterruptOwnedSurface: vi.fn(async () => null),
}));

describe('performRuntimeAction owned surface resolution', () => {
  beforeEach(() => {
    mocks.continueOwnedCodexSession.mockReset();
  });

  it('steers a codex-owned surface even when inventory lookup misses', { timeout: 20_000 }, async () => {
    mocks.continueOwnedCodexSession.mockResolvedValue({ ok: true, note: 'queued' });
    const { performRuntimeAction } = await import('./actions');

    const result = await performRuntimeAction({
      action: 'steer',
      surfaceId: 'codex-owned:abc',
      message: 'continue',
    });

    expect(mocks.continueOwnedCodexSession).toHaveBeenCalledWith('codex-owned:abc', 'continue');
    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      runtime: 'codex',
      surfaceId: 'codex-owned:abc',
      sessionKey: 'codex-owned:abc',
    });
  });
});
