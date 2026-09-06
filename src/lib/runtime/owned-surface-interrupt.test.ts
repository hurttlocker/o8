import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridgeAlive: vi.fn(),
  signalBridge: vi.fn(),
  lookupRun: vi.fn(),
  pidCommandLine: vi.fn(),
  pidAlive: vi.fn(),
  claim: vi.fn(),
  processGroup: vi.fn(),
}));

vi.mock('@/lib/runtime/pty-bridge', () => ({
  isBridgeSessionAlive: mocks.bridgeAlive,
  signalBridgeTerminalSession: mocks.signalBridge,
}));
vi.mock('@/lib/runtimes/shared/owned-session-index', () => ({
  lookupOwnedActiveRunFresh: mocks.lookupRun,
}));
vi.mock('@/lib/runtimes/shared/owned-session/helpers', () => ({
  isPidAlive: mocks.pidAlive,
  pidCommandLine: mocks.pidCommandLine,
}));
vi.mock('@/lib/runtimes/shared/owned-session-lifecycle', () => ({
  getOwnedSessionLifecycle: vi.fn(() => undefined),
}));
vi.mock('@/lib/runtimes', () => ({}));
vi.mock('@/lib/runtimes/shared/owned-session/run-process-proof', () => ({
  probeOwnedRunProcessClaim: mocks.claim,
  resolveSpawnedProcessGroupId: mocks.processGroup,
}));

const { escalateInterruptOwnedSurface } = await import('./interrupt-escalation');

describe('owned surface interrupt authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pidAlive.mockReturnValue(false);
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

  it.each(['mismatch', 'unknown'])('refuses %s run-marker evidence even with a matching binary', async (state) => {
    mocks.lookupRun.mockResolvedValue({
      pid: 4242, processGroupId: 4242, commandIdentity: 'claude', processMarker: 'owned-run',
    });
    mocks.pidAlive.mockReturnValue(true);
    mocks.pidCommandLine.mockResolvedValue('/usr/local/bin/claude');
    mocks.claim.mockResolvedValue({ state });
    const result = await escalateInterruptOwnedSurface('claude-code-owned:marker-authority');
    expect(result).toMatchObject({ attempted: false, confirmedDead: false, steps: [] });
    expect(mocks.claim).toHaveBeenCalledWith({ pid: 4242, marker: 'owned-run', rootPid: 4242 });
    expect(mocks.pidCommandLine).not.toHaveBeenCalled();
    expect(mocks.processGroup).not.toHaveBeenCalled();
  });

  it.each([undefined, 9999])('refuses missing or changed process-group proof (%s)', async (group) => {
    mocks.lookupRun.mockResolvedValue({
      pid: 4242, processGroupId: 4242, commandIdentity: 'sandbox-exec', processMarker: 'owned-run',
    });
    mocks.pidAlive.mockReturnValue(true);
    mocks.claim.mockResolvedValue({ state: 'match' });
    mocks.processGroup.mockResolvedValue(group);
    const result = await escalateInterruptOwnedSurface('claude-code-owned:group-authority');
    expect(result).toMatchObject({ attempted: false, confirmedDead: false, steps: [] });
  });

  it('does not interpret a failed legacy command probe as proof of death', async () => {
    mocks.lookupRun.mockResolvedValue({ pid: 4242, commandIdentity: 'claude' });
    mocks.pidAlive.mockReturnValue(true);
    mocks.pidCommandLine.mockResolvedValue(null);
    expect(await escalateInterruptOwnedSurface('claude-code-owned:legacy-unknown'))
      .toMatchObject({ attempted: false, confirmedDead: false, steps: [] });
  });

  it('refuses a live unmarked legacy PID even when its executable matches', async () => {
    mocks.lookupRun.mockResolvedValue({ pid: 4242, commandIdentity: 'claude' });
    mocks.pidAlive.mockReturnValue(true);
    mocks.pidCommandLine.mockResolvedValue('/usr/local/bin/claude');
    expect(await escalateInterruptOwnedSurface('claude-code-owned:legacy-same-binary'))
      .toMatchObject({ attempted: false, confirmedDead: false, steps: [] });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.pidCommandLine).not.toHaveBeenCalled();
  });
});
