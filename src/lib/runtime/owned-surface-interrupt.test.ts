import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridgeAlive: vi.fn(),
  signalBridge: vi.fn(),
  lookupRun: vi.fn(),
  pidCommandLine: vi.fn(),
}));

vi.mock('@/lib/runtime/pty-bridge', () => ({
  isBridgeSessionAlive: mocks.bridgeAlive,
  signalBridgeTerminalSession: mocks.signalBridge,
}));
vi.mock('@/lib/runtimes/shared/owned-session-index', () => ({
  lookupOwnedActiveRunFresh: mocks.lookupRun,
}));
vi.mock('@/lib/runtimes/shared/owned-session/helpers', () => ({
  isPidAlive: vi.fn(() => false),
  pidCommandLine: mocks.pidCommandLine,
}));
vi.mock('@/lib/runtimes/shared/owned-session-lifecycle', () => ({
  getOwnedSessionLifecycle: vi.fn(() => undefined),
}));
vi.mock('@/lib/runtimes', () => ({}));

const { escalateInterruptOwnedSurface } = await import('./interrupt-escalation');

describe('owned surface interrupt authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trusts and stops a live bridge even when the stored wrapper pid was reused', async () => {
    mocks.lookupRun.mockResolvedValue({
      pid: 4242,
      tmuxSession: 'owned-live-bridge',
      commandIdentity: 'runtime-cli',
    });
    mocks.pidCommandLine.mockResolvedValue('/usr/bin/unrelated-process');
    mocks.bridgeAlive.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await escalateInterruptOwnedSurface('codex-owned:bridge-authority');

    expect(mocks.pidCommandLine).not.toHaveBeenCalled();
    expect(mocks.signalBridge).toHaveBeenCalledWith('owned-live-bridge', 'SIGINT');
    expect(result).toMatchObject({
      attempted: true,
      confirmedDead: true,
      alreadyDead: false,
      tmuxSession: 'owned-live-bridge',
    });
  });
});
