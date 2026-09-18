import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentRuntime, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

const cacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(cacheRoot, 'o8-completion-ledger-model-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

vi.mock('@/lib/approvals/store', () => ({ listApprovalsForContext: () => [] }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/repos/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/projects')>(),
  getActiveProjectScopeForRepoSync: () => ({ projectId: null }),
}));
vi.mock('@/lib/search/transcripts', () => ({ syncTranscriptSearchDocument: () => undefined }));
vi.mock('@/lib/lane/lane-diff-facts', () => ({ getLaneSpokenDiffFacts: () => undefined }));
vi.mock('@/lib/cortex/qa/ask', () => ({ invalidateAnswerCache: () => undefined }));

// #2492 — null passes through to the real capacity service; a number makes the
// snapshot take that long, standing in for the per-runtime shell-outs.
const capacityStub = vi.hoisted(() => ({ delayMs: null as number | null }));
vi.mock('@/lib/runtime/capacity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/capacity-service')>();
  return {
    ...actual,
    getRuntimeCapacityControlSnapshot: async (options?: { fresh?: boolean }) => {
      if (capacityStub.delayMs === null) return actual.getRuntimeCapacityControlSnapshot(options);
      await new Promise((resolve) => setTimeout(resolve, capacityStub.delayMs ?? 0));
      return {
        schema: 'o8/runtime-capacity-control/v1' as const,
        generatedAt: Date.now(),
        capacities: [],
        identities: [],
        runtimes: [],
      };
    },
  };
});

function outcomeRow(packetId: string): { model: string | null } | undefined {
  return getSqliteRef!().prepare('SELECT model FROM session_outcomes WHERE packet_id = ?')
    .get(packetId) as { model: string | null } | undefined;
}

let getSqliteRef: (typeof import('@/lib/db'))['getSqlite'] | null = null;

function makeRepo(): string {
  const repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'completion ledger model test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function transcript(packetId: string): RuntimeTranscriptEntry[] {
  return [{
    id: `entry-${packetId}`,
    role: 'assistant',
    text: `Completed ${packetId}`,
    timestamp: new Date('2026-08-23T12:00:00.000Z'),
  }];
}

beforeAll(async () => {
  const runtime: AgentRuntime = {
    id: 'codex',
    displayName: 'Completion ledger test runtime',
    capabilities: {
      discover: false,
      readTranscript: true,
      launch: false,
      resume: false,
      interrupt: false,
      reviewDiffs: true,
      costTelemetry: false,
      streaming: false,
    },
    discoverSessions: async () => [],
    readTranscript: async (sessionKey) => transcript(sessionKey.split(':').pop() ?? 'packet'),
    launch: async () => ({ ok: false, note: 'not supported' }),
    resume: async () => ({ ok: false, note: 'not supported' }),
    interrupt: async () => ({ ok: false, note: 'not supported' }),
    getChangedFiles: async () => [],
  };
  const { registerRuntime } = await import('@/lib/runtimes/registry');
  registerRuntime(runtime);
  getSqliteRef = (await import('@/lib/db')).getSqlite;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('completion ledger resolved model real path', () => {
  it('records the persisted lane model when runtime telemetry and inventory have none', async () => {
    const repoPath = makeRepo();
    const { createLane, updateLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      branch: 'inline/lane-model-ledger',
      runtime: 'codex',
      packetId: 'lane-model-ledger',
      sessionKey: 'codex-owned:lane-model-ledger',
    });
    updateLane(lane.id, { model: 'gpt-5.6-sol' });

    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext('lane-model-ledger', 'codex-owned:lane-model-ledger');

    await vi.waitFor(() => {
      expect(outcomeRow('lane-model-ledger'), 'session_outcomes row for lane-model-ledger was never written')
        .toBeDefined();
    });
    expect(outcomeRow('lane-model-ledger')).toEqual({ model: 'gpt-5.6-sol' });
  });

  it('records unknown instead of a runtime id when no model resolves', async () => {
    const repoPath = makeRepo();
    const { createLane } = await import('@/lib/lane/registry');
    createLane({
      repoPath,
      branch: 'inline/unknown-model-ledger',
      runtime: 'codex',
      packetId: 'unknown-model-ledger',
      sessionKey: 'codex-owned:unknown-model-ledger',
    });

    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext('unknown-model-ledger', 'codex-owned:unknown-model-ledger');

    await vi.waitFor(() => {
      expect(outcomeRow('unknown-model-ledger'), 'session_outcomes row for unknown-model-ledger was never written')
        .toBeDefined();
    });
    const row = outcomeRow('unknown-model-ledger');
    expect(row).toEqual({ model: 'unknown' });
    expect(row).not.toEqual({ model: 'codex' });
  });

  it('writes the ledger row without waiting on a slow end capacity snapshot (#2492)', async () => {
    capacityStub.delayMs = 3_000;
    try {
      const repoPath = makeRepo();
      const { createLane } = await import('@/lib/lane/registry');
      const lane = createLane({
        repoPath,
        branch: 'inline/slow-capacity-ledger',
        runtime: 'codex',
        packetId: 'slow-capacity-ledger',
        sessionKey: 'codex-owned:slow-capacity-ledger',
      });

      const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
      await capturePacketCompletionContext('slow-capacity-ledger', 'codex-owned:slow-capacity-ledger');

      await vi.waitFor(() => {
        expect(outcomeRow('slow-capacity-ledger'), 'session_outcomes row waited on the capacity snapshot')
          .toBeDefined();
      }, { timeout: 500, interval: 20 });

      const { getLaneEvents } = await import('@/lib/lane/registry');
      const endSnapshots = () => getLaneEvents(lane.id, 10_000).filter((event) => (
        event.verb === 'capacity_snapshot' && event.payload.phase === 'end'
      ));
      expect(endSnapshots()).toHaveLength(0);
      await vi.waitFor(() => {
        expect(endSnapshots(), 'end capacity snapshot never landed').toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
    } finally {
      capacityStub.delayMs = null;
    }
  }, 20_000);
});
