import { describe, it, expect } from 'vitest';
import { isRestingOnDefaultBranch } from './MergeActionCluster';

const idle = { variant: 'idle' as const, pr: null };
const withPr = { variant: 'view' as const, pr: { number: 7 } as never };
const idleButPr = { variant: 'idle' as const, pr: { number: 7 } as never };

describe('isRestingOnDefaultBranch', () => {
  it('is quiet on the default branch with nothing open', () => {
    expect(isRestingOnDefaultBranch('main', 'main', idle)).toBe(true);
  });

  it('speaks up on a PR branch', () => {
    expect(isRestingOnDefaultBranch('fix/the-thing', 'main', idle)).toBe(false);
  });

  it("speaks up on an agent's worktree branch", () => {
    expect(isRestingOnDefaultBranch('o8/packet-1234', 'main', idle)).toBe(false);
  });

  it('respects a repo whose default is not main', () => {
    // The reason defaultBranch is passed rather than assumed: hardcoding 'main'
    // would leave these repos with a permanent branch chip.
    expect(isRestingOnDefaultBranch('master', 'master', idle)).toBe(true);
    expect(isRestingOnDefaultBranch('develop', 'develop', idle)).toBe(true);
    expect(isRestingOnDefaultBranch('main', 'develop', idle)).toBe(false);
  });

  it('keeps the chrome when a PR is open against the default branch', () => {
    expect(isRestingOnDefaultBranch('main', 'main', withPr)).toBe(false);
    expect(isRestingOnDefaultBranch('main', 'main', idleButPr)).toBe(false);
  });

  it('shows the chip when the default branch is unknown rather than guessing', () => {
    expect(isRestingOnDefaultBranch('main', null, idle)).toBe(false);
    expect(isRestingOnDefaultBranch('main', undefined, idle)).toBe(false);
  });

  it('is false with no branch at all — the caller already renders nothing', () => {
    expect(isRestingOnDefaultBranch(null, 'main', idle)).toBe(false);
  });
});
