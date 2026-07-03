import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createMission } = await import('./mission');
const { currentMissionState, slugify } = await import('./shared');

function createRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-inline-branch-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init');
  return repoPath;
}

describe('inline packet branch names', () => {
  it('pins inline branch format and truncates the slug to a short branch name', async () => {
    const repoPath = createRepo();
    const title = `Ship the collision-proof inline branch target ${'x'.repeat(120)}`;

    await createMission({
      issues: [{ number: 90001, title, body: 'do the thing', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });

    const [packet] = currentMissionState().packets;
    expect(packet?.branchTarget).toMatch(/^inline\/90001-[a-z0-9-]+$/);
    expect(packet?.branchTarget.startsWith('inline/90001-')).toBe(true);
    expect(packet?.branchTarget.length).toBeLessThanOrEqual(60);
    expect(packet?.branchTarget).not.toBe(`inline/${slugify(title)}`);
  });

  it('keeps GitHub issue branch names on the existing issue-number scheme', async () => {
    const repoPath = createRepo();

    await createMission({
      issues: [{
        number: 123,
        title: 'Fix auth flow',
        body: '',
        url: 'https://github.com/o8/o8/issues/123',
      }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });

    const [packet] = currentMissionState().packets;
    expect(packet?.branchTarget).toBe('issue/123-fix-auth-flow');
  });

  it('allows identical inline titles to coexist without archiving the active first lane', async () => {
    const repoPath = createRepo();
    const title = 'Inline branch collision task';

    const firstMission = await createMission({
      issues: [{ number: 90010, title, body: 'first body', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });
    const firstPacket = currentMissionState().packets[0]!;
    const firstLane = createLane({
      repoPath,
      branch: firstPacket.branchTarget,
      runtime: 'codex',
      packetId: firstPacket.id,
    });
    setLaneStatus(firstLane.id, 'running', 'system');

    const secondMission = await createMission({
      issues: [{ number: 90020, title, body: 'second body', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });
    const secondPacket = currentMissionState().packets[0]!;

    expect(firstMission.missionId).not.toBe(secondMission.missionId);
    expect(firstPacket.branchTarget).toBe('inline/90010-inline-branch-collision-task');
    expect(secondPacket.branchTarget).toBe('inline/90020-inline-branch-collision-task');
    expect(firstPacket.branchTarget).not.toBe(secondPacket.branchTarget);
    expect(secondMission.branchPreparation).toEqual([]);

    const preservedLane = getLane(firstLane.id);
    expect(preservedLane?.status).toBe('running');
    expect(preservedLane?.packetId).toBe(firstPacket.id);
    expect(preservedLane?.branch).toBe(firstPacket.branchTarget);
  });
});
