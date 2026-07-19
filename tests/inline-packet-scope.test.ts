import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-inline-packet-scope-data-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

vi.mock('@/lib/runtime/registry', () => ({
  getRuntimeProcessForWorktree: vi.fn(async () => null),
}));

const { createLane } = await import('@/lib/lane/registry');
const { handleGetPacketScope } = await import('@/lib/mcp/operator-handlers/mission');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

describe('get_packet_scope inline packet contract', () => {
  it('reports repo-wide allowed paths instead of heuristic predicted files', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-inline-packet-scope-repo-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const packetId = 'pkt-inline-scope-real-path';
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/scope-real-path',
      runtime: 'codex',
      packetId,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-inline-scope',
      repoPath,
      packets: [{
        id: packetId,
        referenceLabel: 'inline-1',
        title: 'Add a new runtime adapter',
        summary: 'Inline task requiring files beyond the heuristic matches.',
        workspaceTargetPath: repoPath,
        branchTarget: 'inline/scope-real-path',
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        lane: null,
        predictedFiles: ['CLAUDE.md', 'src/lib/runtimes/claude-code.ts'],
        issue: { number: 90001, body: 'Build the adapter.' },
      }],
    });

    const result = await handleGetPacketScope({ packetId });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '{}';
    const scope = JSON.parse(text) as { laneId: string; allowedPaths: string[] };

    expect(result.isError).not.toBe(true);
    expect(scope.laneId).toBe(lane.id);
    expect(scope.allowedPaths).toEqual(['**/*']);
  });
});
