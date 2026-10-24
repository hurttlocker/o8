/** Authored persisted histories; all runtime roots belong to the disposable host. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function seedTranscriptFixtures(dataDir: string, repo: string) {
  const rich = JSON.parse(readFileSync('native/o8-next/fixtures/rich.session.json', 'utf8'));
  const long = { id: 'thoughts-pagination', title: 'Pagination fixture', messages: Array.from({ length: 2000 }, (_, index) => ({
    id: `page-${index + 1}`, role: index % 2 ? 'assistant' : 'user', content: `History row ${index + 1}`,
    timestamp: 1790812800000 + index * 1000,
  })) };
  for (const seed of [rich, long]) {
    writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
      repoPath: repo, backend: 'claude', model: 'claude-code', orchestratorVisible: true,
      savedAt: '2026-10-01T01:00:00.000Z',
    }));
  }
  const ownedRoot = join(dataDir, 'owned-opencode');
  process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;
  const sessionDir = join(ownedRoot, 'next-worker');
  mkdirSync(sessionDir, { recursive: true });
  const stdoutPath = join(sessionDir, 'run.jsonl');
  const observedAt = new Date().toISOString();
  writeFileSync(stdoutPath, JSON.stringify({ type: 'text', timestamp: '2026-10-01T00:00:01.000Z',
    part: { type: 'text', text: 'Worker history reached GPUI.' } }) + '\n');
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: 'opencode-owned:next-worker', sessionDir, cwd: repo, repoPath: repo,
    title: 'Native worker fixture', createdAt: observedAt, updatedAt: observedAt,
    latestPrompt: 'Read the worker history.', latestSummary: 'Worker history reached GPUI.', activeRun: null,
    recentRuns: [{ id: 'fixture-run', mode: 'launch', prompt: 'Read the worker history.',
      startedAt: observedAt, finishedAt: observedAt,
      stdoutPath, stderrPath: join(sessionDir, 'stderr.log'), outcome: 'finished' }],
  }));
  return [rich, long] as Array<{ id: string; title: string; messages: Array<Record<string, unknown>> }>;
}

export async function isolateTranscriptDiscovery(owned: boolean) {
  const { getAllRuntimes } = await import('../../src/lib/runtimes');
  // Only the owned opencode adapter reads a fixture. Never inspect installed
  // provider sessions or call executables from a protocol test.
  for (const runtime of getAllRuntimes()) {
    if (!owned || runtime.id !== 'opencode') runtime.discoverSessions = async () => [];
  }
  if (owned) {
    const { createLane } = await import('../../src/lib/lane/registry');
    const { withLockedState } = await import('../../src/lib/orchestrator/control-plane');
    const root = process.env.O8_OWNED_OPENCODE_ROOT!;
    const record = JSON.parse(readFileSync(join(root, 'next-worker', 'session.json'), 'utf8'));
    createLane({ repoPath: record.repoPath, worktreePath: record.repoPath, branch: 'fixture/transcript',
      runtime: 'opencode', packetId: 'next-worker-packet', sessionKey: record.surfaceId });
    await withLockedState(state => {
      state.packets.push({ id: 'next-worker-packet', referenceLabel: 'fixture-worker', title: 'Worker packet header',
        summary: 'Read the worker history.', workspaceTargetPath: record.repoPath, branchTarget: 'fixture/transcript',
        runtime: 'opencode', dependencyLabels: [], dependencyPacketIds: [], queueState: 'held',
        releaseState: 'pending', status: 'awaiting_review',
      } as typeof state.packets[number]);
    });
  }
}
