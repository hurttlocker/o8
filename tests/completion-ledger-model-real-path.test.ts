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

    const { getSqlite } = await import('@/lib/db');
    await vi.waitFor(() => {
      expect(getSqlite().prepare('SELECT model FROM session_outcomes WHERE packet_id = ?')
        .get('lane-model-ledger')).toEqual({ model: 'gpt-5.6-sol' });
    });
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

    const { getSqlite } = await import('@/lib/db');
    await vi.waitFor(() => {
      const row = getSqlite().prepare('SELECT model FROM session_outcomes WHERE packet_id = ?')
        .get('unknown-model-ledger');
      expect(row).toEqual({ model: 'unknown' });
      expect(row).not.toEqual({ model: 'codex' });
    });
  });
});
