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
    registryFixture.runtimes = [];
    invalidateRuntimeInventoryCache();
  });

  it('matches main policy by never discovering non-dispatchable registered adapters', async () => {
    const geminiRuntime = runtime('gemini');
    const aiderRuntime = runtime('aider');
    const cloudRuntime = runtime('cloud');
    const remoteCustomerRuntime = runtime('remote-customer');
    const cloudDiscovery = vi.spyOn(cloudRuntime, 'discoverSessions');
    const remoteCustomerDiscovery = vi.spyOn(remoteCustomerRuntime, 'discoverSessions');
    registryFixture.runtimes = [
      geminiRuntime,
      aiderRuntime,
      cloudRuntime,
      remoteCustomerRuntime,
    ];
    invalidateRuntimeInventoryCache();

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(cloudDiscovery).not.toHaveBeenCalled();
    expect(remoteCustomerDiscovery).not.toHaveBeenCalled();
    expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider']);
    expect(snapshot.agents.map((agent) => agent.identityId)).toEqual([
      'gemini-identity',
      'aider-identity',
    ]);
    expect(snapshot.meta.note).toBe('Showing every discovered dispatchable runtime surface.');
  });

  it('uses total unknown evidence for an invalid observation without dropping healthy sessions', async () => {
    const malformedRuntime = runtime('aider');
    const discoverSessions = malformedRuntime.discoverSessions;
    malformedRuntime.discoverSessions = async () => {
      const sessions = await discoverSessions();
      return sessions.map((session) => ({ ...session, lastActivityAt: new Date('not-a-time') }));
    };
    registryFixture.runtimes = [runtime('gemini'), malformedRuntime];
    invalidateRuntimeInventoryCache();

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider']);
    expect(snapshot.agents.find((agent) => agent.runtime === 'aider')?.statusEvidence)
      .toMatchObject({
        runtime: 'aider',
        state: 'unknown',
        authority: 'raw-terminal',
        summary: 'No observation with a valid time was available.',
        evidence: [],
      });
  });

  it('contains a missing session identity and warns without dropping peers', async () => {
    const malformedRuntime = runtime('aider');
    const discoverSessions = malformedRuntime.discoverSessions;
    malformedRuntime.discoverSessions = async () => {
      const sessions = await discoverSessions();
      return sessions.map((session) => ({ ...session, sessionKey: '' }));
    };
    registryFixture.runtimes = [runtime('gemini'), malformedRuntime];
    invalidateRuntimeInventoryCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

      expect(snapshot.agents).toHaveLength(2);
      expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider']);
      expect(snapshot.agents[1].statusEvidence).toMatchObject({
        sessionId: 'aider',
        runtime: 'aider',
        state: 'unknown',
        authority: 'raw-terminal',
        evidence: [],
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[terminal-status]'));
    } finally {
      warn.mockRestore();
    }
  });
});
