import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('keeps directive bodies opt-in through the real MCP handler', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-bounded-packet-scope-repo-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const directivesDir = join(dataDir, 'directives');
    mkdirSync(directivesDir, { recursive: true });
    for (let index = 0; index < 72; index += 1) {
      writeFileSync(join(directivesDir, `bounded-${index}.md`), [
        '---',
        `id: bounded-${index}`,
        `title: Bounded directive ${index}`,
        'scope: global',
        '---',
        'x'.repeat(20_000),
      ].join('\n'));
    }

    const packetId = 'pkt-bounded-scope-real-handler';
    createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/bounded-scope',
      runtime: 'codex',
      packetId,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-bounded-scope',
      repoPath,
      packets: [{
        id: packetId,
        referenceLabel: 'bounded-1',
        title: 'Bound packet scope',
        summary: 'Keep directive bodies out of the default MCP response.',
        workspaceTargetPath: repoPath,
        branchTarget: 'fix/bounded-scope',
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        lane: null,
      }],
    });

    const boundedResult = await handleGetPacketScope({ packetId });
    const boundedText = boundedResult.content[0]?.type === 'text'
      ? boundedResult.content[0].text
      : '{}';
    const bounded = JSON.parse(boundedText) as {
      directiveCount: number;
      directives: Array<Record<string, unknown>>;
    };

    expect(Buffer.byteLength(boundedText, 'utf8')).toBeLessThan(64 * 1024);
    expect(bounded.directiveCount).toBe(72);
    expect(bounded.directives).toHaveLength(72);
    expect(bounded.directives.every((directive) => (
      Object.keys(directive).sort().join(',') === 'id,title'
    ))).toBe(true);

    const fullResult = await handleGetPacketScope({ packetId, includeDirectives: true });
    const fullText = fullResult.content[0]?.type === 'text' ? fullResult.content[0].text : '{}';
    const full = JSON.parse(fullText) as {
      directiveCount: number;
      directives: Array<{ body?: string }>;
    };

    expect(full.directiveCount).toBe(72);
    expect(full.directives).toHaveLength(72);
    expect(full.directives[0]?.body).toHaveLength(20_000);
    expect(Buffer.byteLength(fullText, 'utf8')).toBeGreaterThan(1_400_000);
  });
});
