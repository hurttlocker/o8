import { describe, expect, it } from 'vitest';
import { runtimeDriftIsAttributable } from './scope';

const REPO = '/Users/dev/o8';
const WORKTREE = '/Users/dev/.o8/worktrees/o8-56fb96a161ae/.cortex-worktrees/packet-pkt-2b597664';

describe('runtimeDriftIsAttributable (#1838)', () => {
  it('refuses to attribute a process in the shared repo root', () => {
    // The reported false record: a lane with no worktree fell back to the repo
    // path, matched the operator's own resident `claude --dangerously-skip-
    // permissions` session (up for over a day), and recorded the packet as
    // having drifted from codex to claude-code.
    expect(runtimeDriftIsAttributable(null, REPO, REPO)).toBe(false);
    expect(runtimeDriftIsAttributable(undefined, REPO, REPO)).toBe(false);
    expect(runtimeDriftIsAttributable('', REPO, REPO)).toBe(false);
  });

  it('refuses when the lane names the repo root as its worktree', () => {
    expect(runtimeDriftIsAttributable(REPO, REPO, REPO)).toBe(false);
  });

  it('attributes a process running inside the packet worktree', () => {
    expect(runtimeDriftIsAttributable(WORKTREE, REPO, WORKTREE)).toBe(true);
    expect(runtimeDriftIsAttributable(WORKTREE, REPO, `${WORKTREE}/src/lib`)).toBe(true);
  });

  it('refuses a process outside the worktree, including a sibling packet', () => {
    expect(runtimeDriftIsAttributable(WORKTREE, REPO, REPO)).toBe(false);
    expect(runtimeDriftIsAttributable(WORKTREE, REPO, `${WORKTREE}-other/src`)).toBe(false);
    expect(runtimeDriftIsAttributable(WORKTREE, REPO, null)).toBe(false);
  });
});
