import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const explainerMocks = vi.hoisted(() => ({
  patchMissionPacket: vi.fn(),
  ensureSession: vi.fn(() => ({ status: 'idle' })),
  sendTurn: vi.fn(),
}));

vi.mock('@/lib/orchestrator/operator-mission-service/packet-patch', () => ({
  patchMissionPacket: explainerMocks.patchMissionPacket,
}));

vi.mock('./orchestrator-backends/registry', () => {
  const backend = {
    id: 'codex',
    label: 'Codex',
    ensureSession: explainerMocks.ensureSession,
    sendTurn: explainerMocks.sendTurn,
  };
  return {
    getActiveReviewerBackend: () => backend,
    getOrchestratorBackend: () => backend,
  };
});

// store.ts (imported transitively) resolves the data dir at load — set first.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-explainer-'));

const { generatePacketExplainer } = await import('./packet-explainer');
const { artifactAbsPath, artifactExtForMime, listArtifacts } = await import('@/lib/artifacts/store');
const { createLane } = await import('@/lib/lane/registry');

describe('artifactExtForMime', () => {
  it('maps report HTML to an .html extension', () => {
    expect(artifactExtForMime('text/html')).toBe('html');
  });
  it('falls back to png for unknown types', () => {
    expect(artifactExtForMime('application/octet-stream')).toBe('png');
  });
});

describe('generatePacketExplainer', () => {
  it('keeps the durable report artifact and removes the worktree scratch HTML', async () => {
    const worktree = mkdtempSync(join(os.tmpdir(), 'o8-explainer-worktree-'));
    const packetId = `pkt-cleanup-${Date.now()}`;
    let scratchPath = '';
    const html = `<html><body><h1>Packet proof</h1></body></html>`;
    const lane = createLane({
      repoPath: worktree,
      worktreePath: worktree,
      branch: 'inline/packet-explainer-test',
      runtime: 'codex',
      packetId,
    });

    explainerMocks.patchMissionPacket.mockClear();
    explainerMocks.sendTurn.mockReset();
    explainerMocks.sendTurn.mockImplementationOnce(async (_repo, prompt, _onEvent, options) => {
      expect(prompt).toContain('Do not include quizzes or comprehension tests.');
      expect(options.threadId).toMatch(/^thoughts-explainer-/);
      scratchPath = join(worktree, prompt.match(/named exactly `([^`]+)`/)[1]);
      writeFileSync(scratchPath, html, 'utf8');
    });

    await generatePacketExplainer({
      lane,
      packetId,
      packetTitle: 'Cleanup proof',
      packetSummary: 'Persist the report and remove its scratch copy.',
      diffSummary: '1 file changed',
      changedFileCount: 1,
      deviationsRaw: null,
      reviewContext: 'No findings.',
    });

    expect(existsSync(scratchPath)).toBe(false);
    const reports = listArtifacts({ packetId });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'report', laneId: lane.id, mimeType: 'text/html' });
    expect(readFileSync(artifactAbsPath(reports[0].relPath), 'utf8')).toBe(html);
    expect(explainerMocks.patchMissionPacket).toHaveBeenLastCalledWith(
      packetId,
      expect.objectContaining({
        explainer: expect.objectContaining({ status: 'ready', artifactId: reports[0].id, quiz: null }),
      }),
      expect.any(Function),
    );
  });

  it('does not publish a superseded generation or reuse another attempt output file', async () => {
    const worktree = mkdtempSync(join(os.tmpdir(), 'o8-explainer-fence-'));
    const packetId = `pkt-fence-${Date.now()}`;
    const lane = createLane({ repoPath: worktree, worktreePath: worktree,
      branch: 'inline/explainer-fence', runtime: 'codex', packetId });
    let current = true;
    const files: string[] = [];
    explainerMocks.patchMissionPacket.mockClear();
    explainerMocks.sendTurn.mockReset();
    explainerMocks.sendTurn.mockImplementation(async (_repo, prompt) => {
      const output = join(worktree, prompt.match(/named exactly `([^`]+)`/)[1]);
      files.push(output);
      writeFileSync(output, '<html>Report</html>');
      current = false;
    });
    const params = { lane, packetId, packetTitle: 'Fence', packetSummary: '',
      diffSummary: '', changedFileCount: 1, deviationsRaw: null, reviewContext: '',
      isCurrent: () => current };
    expect((await generatePacketExplainer(params)).outcome).toBe('deferred');
    current = true;
    expect((await generatePacketExplainer(params)).outcome).toBe('deferred');
    expect(new Set(files).size).toBe(2);
    expect(files.every(existsSync)).toBe(true);
    expect(listArtifacts({ packetId })).toHaveLength(0);
    expect(explainerMocks.patchMissionPacket).not.toHaveBeenCalled();
  });
});
