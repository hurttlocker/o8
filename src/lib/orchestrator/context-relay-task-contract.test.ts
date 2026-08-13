import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentRuntime, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-context-contract-'));

vi.mock('@/lib/approvals/store', () => ({
  listApprovalsForContext: () => [],
}));

vi.mock('@/lib/lane/registry', () => ({
  findLaneByPacket: () => null,
}));

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: [] }),
}));

vi.mock('@/lib/repos/projects', () => ({
  getActiveProjectScopeForRepoSync: () => ({ projectId: null }),
}));

vi.mock('@/lib/search/transcripts', () => ({
  syncTranscriptSearchDocument: () => undefined,
}));

const firstContract = {
  version: 1 as const,
  requirements: [{
    id: 'R1',
    source: 'Capture the pre-edit contract.',
    expectedBehavior: 'The first valid contract reaches completion context.',
    productionPath: 'capturePacketCompletionContext',
    verification: 'context relay test',
  }],
  smallestRoute: [{
    path: 'src/lib/orchestrator/context-relay.ts',
    requirements: ['R1'],
    reason: 'The relay owns transcript persistence.',
  }],
  exclusions: [],
};

const laterContract = {
  ...firstContract,
  requirements: [{
    ...firstContract.requirements[0],
    expectedBehavior: 'A later contract must not replace the first one.',
  }],
};

function entry(id: string, text: string): RuntimeTranscriptEntry {
  return {
    id,
    role: 'assistant',
    text,
    timestamp: new Date(`2026-08-02T12:00:0${id}.000Z`),
  };
}

describe('completion context task contract relay', () => {
  beforeAll(async () => {
    const transcript = [
      entry('1', `<task-contract>${JSON.stringify(firstContract)}</task-contract>`),
      entry('2', 'Implementation finished.'),
      entry('3', `<task-contract>${JSON.stringify(laterContract)}</task-contract>\nFinal summary.`),
    ];
    const runtime: AgentRuntime = {
      id: 'codex',
      displayName: 'Codex test runtime',
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
      readTranscript: async () => transcript,
      launch: async () => ({ ok: false, note: 'not supported' }),
      resume: async () => ({ ok: false, note: 'not supported' }),
      interrupt: async () => ({ ok: false, note: 'not supported' }),
      getChangedFiles: async () => [],
    };
    const { registerRuntime } = await import('@/lib/runtimes/registry');
    registerRuntime(runtime);
    registerRuntime({
      ...runtime,
      id: 'opencode',
      displayName: 'OpenCode test runtime',
      readTranscript: async () => [entry('4', `<self-review>${JSON.stringify({
        passed: true,
        confidence: 'high',
        summary: 'The read-only finding is supported.',
        outcome: 'The configuration lacks the required guard.',
        evidence: ['Observed the missing guard in the production configuration.'],
        residual: 'Implementation remains intentionally out of scope.',
        decision: 'finding_ready',
      })}</self-review>`) ],
    });
  });

  it('persists the first valid contract and strips contract blocks from the summary', async () => {
    const { capturePacketCompletionContext } = await import('./context-relay');
    const context = await capturePacketCompletionContext('pkt-contract-relay', 'codex:test-contract');

    expect(context.taskContract).toEqual(firstContract);
    expect(context.summary).toBe('Final summary.');
  }, 15_000);

  it('does not promote a failed self-review receipt to a successful outcome', async () => {
    const { outcomeFromPacketSelfReview } = await import('./context-relay-outcome');

    expect(outcomeFromPacketSelfReview(undefined)).toBe('partial');
    expect(outcomeFromPacketSelfReview({
      passed: false,
      confidence: 'low',
      issuesFound: ['Unable to verify the production path.'],
      residual: 'The reported failure remains.',
      decision: 'blocked',
      summary: 'Investigation is blocked.',
    })).toBe('failed');
    expect(outcomeFromPacketSelfReview({
      passed: true,
      confidence: 'high',
      issuesFound: [],
      residual: 'No known residual.',
      decision: 'implementation_ready',
      summary: 'The implementation is verified.',
    })).toBe('succeeded');
    expect(outcomeFromPacketSelfReview({
      passed: true,
      confidence: 'high',
      issuesFound: [],
      residual: 'Implementation remains intentionally out of scope.',
      decision: 'finding_ready',
      summary: 'Evidence was omitted.',
    })).toBe('partial');
  });

  it('captures owned-session transcripts through the generic runtime registry', async () => {
    const { capturePacketCompletionContext } = await import('./context-relay');
    const context = await capturePacketCompletionContext(
      'pkt-opencode-read-only',
      'opencode-owned:test-read-only',
    );

    expect(context.selfReview).toMatchObject({
      passed: true,
      decision: 'finding_ready',
      outcome: 'The configuration lacks the required guard.',
    });
  });
});
