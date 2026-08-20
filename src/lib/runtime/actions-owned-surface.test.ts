import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  continueOwnedCodexSession: vi.fn(),
  getRuntimeInventorySnapshot: vi.fn(),
  listLanes: vi.fn(),
  recordLaneEvent: vi.fn(),
  getRuntime: vi.fn(),
  escalateInterrupt: vi.fn(),
  escalateInterruptOwnedSurface: vi.fn(),
}));

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: mocks.getRuntimeInventorySnapshot,
}));

// Partial mock: other modules in this import graph bind registry exports at
// load time, so a replacement factory rots the moment the registry grows one.
vi.mock('@/lib/lane/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/registry')>(),
  listLanes: mocks.listLanes,
}));

vi.mock('@/lib/lane/events', () => ({
  recordLaneEvent: mocks.recordLaneEvent,
}));

vi.mock('@/lib/codex/owned', () => ({
  continueOwnedCodexSession: mocks.continueOwnedCodexSession,
  interruptOwnedCodexSession: vi.fn(),
  setOwnedCodexReviewDisposition: vi.fn(),
}));

vi.mock('@/lib/runtime/interrupt-escalation', () => ({
  escalateInterrupt: mocks.escalateInterrupt,
  escalateInterruptOwnedSurface: mocks.escalateInterruptOwnedSurface,
}));

vi.mock('@/lib/runtimes', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes')>(),
  getRuntime: mocks.getRuntime,
}));

describe('performRuntimeAction owned surface resolution', () => {
  beforeEach(() => {
    mocks.continueOwnedCodexSession.mockReset();
    mocks.getRuntimeInventorySnapshot.mockReset();
    mocks.getRuntimeInventorySnapshot.mockResolvedValue({ agents: [] });
    mocks.listLanes.mockReset();
    mocks.listLanes.mockReturnValue([]);
    mocks.recordLaneEvent.mockReset();
    mocks.getRuntime.mockReset();
    mocks.escalateInterrupt.mockReset();
    mocks.escalateInterruptOwnedSurface.mockReset();
    mocks.escalateInterruptOwnedSurface.mockResolvedValue(null);
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

  it('returns a retryable operator-safe result without auditing a not-ready steer', async () => {
    const agent = {
      id: 'codex-owned:not-ready',
      sessionKey: 'codex-owned:not-ready',
      runtime: 'codex',
      runtimeSurface: {
        id: 'codex-owned:not-ready',
        ownership: 'owned',
        capabilities: { sendInput: false },
      },
    };
    mocks.getRuntimeInventorySnapshot.mockResolvedValue({ agents: [agent] });
    const { performRuntimeAction } = await import('./actions');

    const result = await performRuntimeAction({
      action: 'steer',
      surfaceId: 'codex-owned:not-ready',
      message: 'follow up after this turn',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'unavailable',
      retryable: true,
      reason: 'surface_not_ready',
    });
    expect(result.note).not.toMatch(/IDE-owned|thread id/i);
    expect(mocks.continueOwnedCodexSession).not.toHaveBeenCalled();
    expect(mocks.recordLaneEvent).not.toHaveBeenCalled();
  });

  it('audits an owned Codex steer only after the runtime accepts it', async () => {
    const agent = {
      id: 'codex-owned:ready',
      sessionKey: 'codex-owned:ready',
      runtime: 'codex',
      runtimeSurface: {
        id: 'codex-owned:ready',
        ownership: 'owned',
        capabilities: { sendInput: true },
      },
    };
    mocks.getRuntimeInventorySnapshot.mockResolvedValue({ agents: [agent] });
    mocks.listLanes.mockReturnValue([{ id: 'lane-ready', packetId: 'pkt-ready', sessionKey: 'codex-owned:ready' }]);
    mocks.continueOwnedCodexSession.mockResolvedValue({ ok: true, note: 'queued' });
    const { performRuntimeAction } = await import('./actions');

    const result = await performRuntimeAction({
      action: 'steer',
      surfaceId: 'codex-owned:ready',
      message: 'accepted follow-up',
    });

    expect(result).toMatchObject({ ok: true, status: 'queued' });
    expect(mocks.continueOwnedCodexSession).toHaveBeenCalledWith('codex-owned:ready', 'accepted follow-up');
    expect(mocks.recordLaneEvent).toHaveBeenCalledWith(
      'lane-ready',
      'steered_packet',
      'orchestrator',
      expect.objectContaining({ message: 'accepted follow-up' }),
    );
  });

  it('keeps a readiness race retryable and unaudited', async () => {
    const agent = {
      id: 'codex-owned:racing',
      sessionKey: 'codex-owned:racing',
      runtime: 'codex',
      runtimeSurface: {
        id: 'codex-owned:racing',
        ownership: 'owned',
        capabilities: { sendInput: true },
      },
    };
    mocks.getRuntimeInventorySnapshot.mockResolvedValue({ agents: [agent] });
    mocks.continueOwnedCodexSession.mockRejectedValue(
      new Error('This owned Codex session still has an active run. Wait for it to settle or interrupt it first.'),
    );
    const { performRuntimeAction } = await import('./actions');

    const result = await performRuntimeAction({
      action: 'steer',
      surfaceId: 'codex-owned:racing',
      message: 'race-safe follow-up',
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      reason: 'surface_not_ready',
    });
    expect(mocks.recordLaneEvent).not.toHaveBeenCalled();
  });

  it('does not report a discovered interrupt complete without pid evidence', async () => {
    mocks.getRuntimeInventorySnapshot.mockResolvedValue({
      agents: [{
        id: 'codex:discovered-no-pid',
        sessionKey: 'codex:discovered-no-pid',
        runtime: 'codex',
        runtimeSurface: {
          id: 'codex:discovered-no-pid',
          ownership: 'discovered',
          capabilities: { interrupt: true },
        },
      }],
    });
    mocks.getRuntime.mockReturnValue({
      interrupt: vi.fn(async () => ({ ok: true, note: 'SIGINT sent.' })),
    });
    const { performRuntimeAction } = await import('./actions');

    const result = await performRuntimeAction({
      action: 'interrupt',
      surfaceId: 'codex:discovered-no-pid',
    });

    expect(result).toMatchObject({ ok: false, status: 'unavailable', aborted: false });
    expect(result.note).toContain('no pid evidence');
  });

  it('reports a discovered interrupt complete only after pid exit is confirmed', async () => {
    mocks.getRuntimeInventorySnapshot.mockResolvedValue({
      agents: [{
        id: 'codex:discovered-confirmed',
        sessionKey: 'codex:discovered-confirmed',
        runtime: 'codex',
        runtimeSurface: {
          id: 'codex:discovered-confirmed',
          ownership: 'discovered',
          capabilities: { interrupt: true },
        },
      }],
    });
    mocks.getRuntime.mockReturnValue({
      interrupt: vi.fn(async () => ({ ok: true, note: 'SIGINT sent.', pids: [321] })),
    });
    mocks.escalateInterrupt.mockResolvedValue({ confirmedDead: true, note: 'Worker stopped after SIGTERM.' });
    const { performRuntimeAction } = await import('./actions');

    const result = await performRuntimeAction({
      action: 'interrupt',
      surfaceId: 'codex:discovered-confirmed',
    });

    expect(result).toMatchObject({ ok: true, status: 'completed', aborted: true });
    expect(mocks.escalateInterrupt).toHaveBeenCalledWith({ pid: 321 });
  });
});
