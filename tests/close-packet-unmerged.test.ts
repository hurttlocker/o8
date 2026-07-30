import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-close-unmerged-'));
const wsToken = 'operator-close-unmerged-token-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf-8');

const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const { getDb, closeDb } = await import('@/lib/db');
const { sessionOutcomes } = await import('@/lib/db/schema');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function operatorRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3001/api/orchestrator/discard-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('close_packet_unmerged real path (#1570)', () => {
  it('archives an awaiting-review packet and writes the explicit disposition to durable state', async () => {
    const packetId = 'pkt-close-unmerged-real-path';
    const repoPath = join(dataDir, 'repo');
    const lane = createLane({
      repoPath,
      branch: 'issue/close-unmerged',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Close unmerged real path',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const packet = {
      id: packetId,
      referenceLabel: '#1570',
      title: 'Close packet unmerged',
      summary: 'This work moved to another repository.',
      workspaceTargetPath: repoPath,
      branchTarget: 'main',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        runtime: 'codex',
        laneId: lane.id,
      },
      review: null,
    } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-unmerged-real-path',
      repoPath,
      runtime: 'codex',
      packets: [packet],
      updatedAt: new Date().toISOString(),
    });

    const db = getDb();
    expect(db).not.toBeNull();

    const response = await closeRoute.POST(operatorRequest({
      packetId,
      disposition: 'adopted_elsewhere',
      note: 'Implemented in o8-mobile.',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: {
        closed: true,
        disposition: 'adopted_elsewhere',
        packetId,
      },
    });

    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      outcome: 'closed_unmerged',
      outcomeNote: expect.stringContaining('Adopted elsewhere'),
    });
    const persistedPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(persistedPacket).toMatchObject({
      status: 'archived',
      queueState: 'held',
      lastEventLabel: 'closed_unmerged',
    });
    expect(persistedPacket?.archivedAt).toEqual(expect.any(String));

    const outcome = await db!
      .select({
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        mergedClean: sessionOutcomes.mergedClean,
      })
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.packetId, packetId))
      .get();
    expect(outcome).toEqual({
      outcome: 'adopted_elsewhere',
      summary: expect.stringContaining('Implemented in o8-mobile.'),
      mergedClean: false,
    });
  });

  it('never reports a preserved branch when the production ref postcondition fails (#1631)', async () => {
    const packetId = 'pkt-preservation-postcondition';
    const branch = 'issue/preservation-postcondition';
    const repoPath = mkdtempSync(join(dataDir, 'preservation-repo-'));
    const worktreePath = join(dataDir, 'preservation-source');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    git(repoPath, 'init', '--initial-branch=main');
    git(repoPath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'init');
    git(dataDir, 'clone', repoPath, worktreePath);
    git(worktreePath, 'checkout', '-b', branch);
    writeFileSync(join(worktreePath, 'preserved.ts'), 'export const preserved = true;\n');
    git(worktreePath, 'add', 'preserved.ts');
    git(worktreePath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '-m', 'work to preserve');

    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Preservation postcondition real path',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-preservation-postcondition',
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId,
        referenceLabel: '#1631',
        title: 'Prove preservation ref exists',
        summary: 'Discard must not claim a missing branch.',
        workspaceTargetPath: repoPath,
        branchTarget: branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'held',
        releaseState: 'pending',
        status: 'awaiting_review',
        blockedReason: null,
        lane: {
          tileId: lane.id,
          tabId: lane.id,
          repoPath,
          runtime: 'codex',
          laneId: lane.id,
        },
        review: null,
      } as OrchestratorPacket],
      updatedAt: new Date().toISOString(),
    });

    // Sabotage the real git seam after a successful fetch: delete the fetched
    // ref before returning success. Old code trusted that exit code and emitted
    // a false preservedBranch; the production show-ref postcondition must catch it.
    const realGit = execFileSync('/usr/bin/which', ['git'], {
      encoding: 'utf-8',
    }).trim();
    const fakeBin = mkdtempSync(join(dataDir, 'fake-git-'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
const run = spawnSync(realGit, args, { cwd: process.cwd(), encoding: 'utf-8' });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
if ((run.status ?? 1) === 0 && args[0] === 'fetch') {
  const refspec = args.at(-1) ?? '';
  const separator = refspec.indexOf(':');
  const ref = separator >= 0 ? refspec.slice(separator + 1) : '';
  if (ref.startsWith('refs/heads/')) {
    const deleted = spawnSync(realGit, ['update-ref', '-d', ref], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    if ((deleted.status ?? 1) !== 0) {
      if (deleted.stderr) process.stderr.write(deleted.stderr);
      process.exit(deleted.status ?? 1);
    }
  }
}
process.exit(run.status ?? 1);
`);
    chmodSync(fakeGit, 0o755);

    const originalPath = process.env.PATH;
    let response: Response;
    try {
      process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
      response = await closeRoute.POST(operatorRequest({
        packetId,
        disposition: 'wontfix',
      }));
    } finally {
      process.env.PATH = originalPath;
    }

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      result: {
        preservedBranch: null,
        preservationFailure: {
          code: 'branch_preservation_failed',
          reason: 'ref_verification_failed',
          branch,
          ref: `refs/heads/${branch}`,
        },
        note: expect.stringContaining('Preservation FAILED'),
      },
    });
    expect(() => git(repoPath, 'show-ref', '--verify', `refs/heads/${branch}`)).toThrow();

    const failureEvent = getLaneEvents(lane.id)
      .find((event) => event.verb === 'branch_preservation_failed');
    expect(failureEvent).toMatchObject({
      actor: 'system',
      payload: {
        code: 'branch_preservation_failed',
        reason: 'ref_verification_failed',
        packetId,
        branch,
        ref: `refs/heads/${branch}`,
        gcRisk: true,
        note: expect.stringContaining('dangling Git objects'),
      },
    });
  });
});
