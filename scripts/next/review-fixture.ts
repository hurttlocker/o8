/** Authored disposable Git/packet state; all reads and decisions use production handlers. */
import { execFileSync } from 'node:child_process';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorPacket } from '../../src/lib/orchestrator/types';

export async function seedReviewFixture(repo: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('checkout', '-b', 'main');
  writeFileSync(join(repo, 'removed.json'), '{"before":true}\n');
  writeFileSync(join(repo, 'old name.md'), '# Retained heading\n\n' + 'Rename fixture paragraph.\n'.repeat(20));
  writeFileSync(join(repo, 'changed.rs'), 'fn main() { println!("before"); }\n');
  git('add', '.'); git('commit', '-qm', 'fixture base');
  git('checkout', '-b', 'fixture-review');
  unlinkSync(join(repo, 'removed.json'));
  renameSync(join(repo, 'old name.md'), join(repo, 'new name.md'));
  writeFileSync(join(repo, 'added.ts'), 'export const answer: number = 42;\n');
  writeFileSync(join(repo, 'changed.rs'), 'fn main() { println!("after"); }\n');
  writeFileSync(join(repo, 'large.ts'), Array.from({ length: 20_000 }, (_, i) => `let x${i}=1;`).join('\n') + '\n');
  writeFileSync(join(repo, 'medium.ts'), Array.from({ length: 1_000 }, (_, i) => `let x${i}=1;`).join('\n') + '\n');
  git('add', '.'); git('commit', '-qm', 'fixture diff');
  const { createLane, setLaneStatus } = await import('../../src/lib/lane/registry');
  const { writeOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
  const { createEmptyOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  const packets = ['next-review-approve', 'next-review-reject'].map(id => {
    const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'fixture-review', baseBranch: 'main',
      runtime: 'codex', packetId: id, label: id });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    return { id, referenceLabel: id, title: id, summary: 'Disposable review', workspaceTargetPath: repo,
      branchTarget: 'fixture-review', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'awaiting_review', blockedReason: null,
      lane: null, review: null, attemptCount: 1 } as OrchestratorPacket;
  });
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'next-review-fixture',
    repoPath: repo, runtime: 'codex', packets, updatedAt: new Date().toISOString() });
}
