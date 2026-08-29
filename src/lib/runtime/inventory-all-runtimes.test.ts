import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeId,
  RuntimeSession,
} from '@/lib/runtimes/types';

const registryFixture = vi.hoisted(() => ({
  runtimes: [] as AgentRuntime[],
}));

vi.mock('@/lib/runtimes', () => ({
  getAllRuntimes: () => registryFixture.runtimes,
}));

vi.mock('@/lib/runtime/ide-terminal-state', () => ({
  listCurrentIdeRepoPaths: () => [],
}));

vi.mock('@/lib/runtime/ide-session-registry', () => ({
  listIdeRuntimeSessions: () => [],
  listIdeRuntimeTabs: () => [],
}));

vi.mock('@/lib/runtime/terminal-session-registry', () => ({
  getRuntimeTerminalSession: () => null,
}));

vi.mock('@/lib/lane/registry', () => ({
  getAllEvents: () => [],
  getLaneEvents: () => [],
  listLanes: () => [],
  reconcileLanesWithSessions: () => [],
}));

vi.mock('@/lib/lane/sweep-orphan-sessions', () => ({
  sweepOrphanedOwnedSessions: async () => {},
}));

const {
  getRuntimeInventorySnapshot,
  invalidateRuntimeInventoryCache,
} = await import('./inventory');

const testRoot = mkdtempSync(join(tmpdir(), 'o8-runtime-inventory-all-'));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function runtime(id: RuntimeId): AgentRuntime {
  const cwd = join(testRoot, id);
  mkdirSync(cwd, { recursive: true });
  const lastActivityAt = id === 'gemini'
    ? '2026-07-24T12:00:02.000Z'
    : id === 'aider'
      ? '2026-07-24T12:00:01.000Z'
      : id === 'cloud'
        ? '2026-07-24T12:00:00.000Z'
        : '2026-07-23T12:00:00.000Z';
  const session: RuntimeSession = {
    sessionKey: `${id}-owned:inventory-parity`,
    runtimeId: id,
    displayName: id,
    cwd,
    branch: 'main',
    status: 'running',
    ownership: 'owned',
    identityId: `${id}-identity`,
    sessionCapabilities: {
      canSendInput: false,
      canInterrupt: false,
      canReviewDiffs: true,
    },
    lastActivityAt: new Date(lastActivityAt),
  };

  return {
    id,
    displayName: id,
    capabilities: {
      discover: true,
      readTranscript: true,
      launch: true,
      resume: false,
      interrupt: false,
      reviewDiffs: true,
      costTelemetry: false,
      streaming: false,
    },
    discoverSessions: async () => [session],
    readTranscript: async () => [],
    launch: async () => ({ ok: true, note: 'launched' }),
    resume: async () => ({ ok: false, note: 'not resumable' }),
    interrupt: async () => ({ ok: false, note: 'not interruptible' }),
    getChangedFiles: async () => [],
  };
}

describe('canonical runtime inventory discovery', () => {
  beforeEach(() => {
    registryFixture.runtimes = [runtime('gemini'), runtime('aider'), runtime('cloud')];
    invalidateRuntimeInventoryCache();
  });

  it('discovers owned sessions from every dispatchable registered adapter', async () => {
    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider', 'cloud']);
    expect(snapshot.agents.map((agent) => agent.identityId)).toEqual([
      'gemini-identity',
      'aider-identity',
      'cloud-identity',
    ]);
    expect(snapshot.agents.find((agent) => agent.runtime === 'cloud')?.statusEvidence).toMatchObject({
      runtime: 'cloud',
      authority: 'runtime-event',
      state: 'working',
    });
    expect(snapshot.meta.note).toBe('Showing every discovered dispatchable runtime surface.');
  });
});
