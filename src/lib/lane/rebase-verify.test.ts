import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./rebase-typecheck', () => ({ runLaneRebaseTypecheck: vi.fn() }));
vi.mock('./rebase-tests', () => ({ runLaneRebaseTests: vi.fn() }));
vi.mock('@/lib/operator/defaults', () => ({ resolveMergeTestReplayEnabledSync: vi.fn() }));

import { resolveMergeTestReplayEnabledSync } from '@/lib/operator/defaults';
import { runLaneRebaseTests } from './rebase-tests';
import { runLaneRebaseTypecheck } from './rebase-typecheck';
import { runLaneRebaseVerify } from './rebase-verify';

const typecheck = vi.mocked(runLaneRebaseTypecheck);
const tests = vi.mocked(runLaneRebaseTests);
const setting = vi.mocked(resolveMergeTestReplayEnabledSync);

const input = { cwd: '/tmp/x', actualBranch: 'branch', logPrefix: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runLaneRebaseVerify', () => {
  it('fails with kind:typecheck and never runs tests when typecheck fails', async () => {
    typecheck.mockResolvedValue({ ok: false, output: 'TS1005' });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({ ok: false, kind: 'typecheck', output: 'TS1005' });
    expect(tests).not.toHaveBeenCalled();
  });

  it('is opt-in: with the setting off, tests never run even if they would fail', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockReturnValue(false);
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({ ok: true });
    expect(tests).not.toHaveBeenCalled();
  });

  it('runs the test replay when the setting is on and passes it through on success', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockReturnValue(true);
    tests.mockResolvedValue({ ok: true, skipped: false });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({ ok: true });
    expect(tests).toHaveBeenCalledOnce();
  });

  it('fails with kind:tests when the replay fails', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockReturnValue(true);
    tests.mockResolvedValue({ ok: false, output: 'boom' });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({ ok: false, kind: 'tests', output: 'boom' });
  });

  it('defaults to off (no test run) when the settings read throws', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({ ok: true });
    expect(tests).not.toHaveBeenCalled();
  });
});
