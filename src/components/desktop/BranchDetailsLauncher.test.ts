import { describe, expect, it } from 'vitest';
import { pickActivePacketForRepo } from './BranchDetailsLauncher';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

// The rail is mounted inside EVERY orchestrator tab; each tab hosts a session
// in a specific repo. These cases lock the repo-scoping that stops one repo's
// tab from rendering another repo's branch/Changes/worker/PR.
function packet(id: string, status: string, workspaceTargetPath: string | null): OrchestratorPacket {
  return { id, status, workspaceTargetPath } as unknown as OrchestratorPacket;
}

const O8 = '/Users/q/o8';
const MOBILE = '/Users/q/o8-mobile';

describe('pickActivePacketForRepo', () => {
  const o8Running = packet('o8-1', 'running', O8);
  const mobileReview = packet('mob-1', 'awaiting_review', MOBILE);
  const packets = [o8Running, mobileReview];

  it('scopes the fallback priority pick to the tab repo (ignores a higher-priority foreign packet)', () => {
    // Global picker would return the awaiting_review mobile packet; scoped to o8
    // it must return the o8 running packet, never the mobile one.
    expect(pickActivePacketForRepo(packets, null, O8)).toBe(o8Running);
    expect(pickActivePacketForRepo(packets, null, MOBILE)).toBe(mobileReview);
  });

  it('honors selectedPacketId only when the selected packet belongs to this repo', () => {
    // Selected packet is in this repo → honored.
    expect(pickActivePacketForRepo(packets, 'o8-1', O8)).toBe(o8Running);
    // Selected packet is in ANOTHER repo → ignored; fall back within this repo.
    expect(pickActivePacketForRepo(packets, 'mob-1', O8)).toBe(o8Running);
  });

  it('returns null when no packet belongs to the tab repo', () => {
    expect(pickActivePacketForRepo(packets, null, '/Users/q/other')).toBeNull();
    expect(pickActivePacketForRepo(packets, 'mob-1', '/Users/q/other')).toBeNull();
  });

  it('normalizes trailing slashes on both sides', () => {
    expect(pickActivePacketForRepo([packet('p', 'running', O8 + '/')], null, O8)).not.toBeNull();
    expect(pickActivePacketForRepo([packet('p', 'running', O8)], null, O8 + '/')).not.toBeNull();
  });

  it('falls back to legacy global behavior when repoPath is absent', () => {
    // No repo scope → highest-priority packet anywhere (awaiting_review wins).
    expect(pickActivePacketForRepo(packets, null, null)).toBe(mobileReview);
  });

  it('returns null for empty input', () => {
    expect(pickActivePacketForRepo([], null, O8)).toBeNull();
    expect(pickActivePacketForRepo(undefined, null, O8)).toBeNull();
  });
});
