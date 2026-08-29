import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-single-sub-ladder-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service');
const {
  resolveBrainCodexRouteSync,
  resolveBrainUseClaudeCliSync,
  resolveBrainUseCodexCliSync,
} = await import('@/lib/operator/brain-routing');

afterEach(() => {
  rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
});

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-single-sub-1',
    referenceLabel: 'P1',
    title: 'single-sub token ladder',
    summary: 'Exercise the cheap-tier rerun ladder.',
    workspaceTargetPath: null,
    branchTarget: 'inline/single-sub-token-ladder',
    runtime: 'claude-code',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'awaiting_review',
    attemptCount: 1,
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    assignedModel: 'claude-sonnet-5',
    workerIntent: 'heavy_worker',
    workerRouting: {
      workerIntent: 'heavy_worker',
      requestedProvider: null,
      requestedRuntime: 'claude-code',
      requestedModel: 'claude-sonnet-5',
      requestedEffort: null,
      selectedProvider: 'claude',
      selectedRuntime: 'claude-code',
      selectedModel: 'claude-sonnet-5',
      modelDisposition: 'requested',
      selectedEffort: null,
      enforcement: 'dispatchable_runtimes',
      confidence: 'medium',
      reason: 'test',
      decidedAt: '2026-07-02T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('single-subscription token ladder rerun escalation', () => {
  it('routes Brain CLI work only to the configured subscription house', () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({
        subscriptionProfile: 'codex-only',
        brainUseClaudeCli: true,
        brainCodexModel: 'gpt-5.6-terra',
        brainCodexEffort: 'xhigh',
      }, null, 2)}\n`,
      'utf-8',
    );
    expect(resolveBrainUseClaudeCliSync()).toBe(false);
    expect(resolveBrainUseCodexCliSync()).toBe(true);
    expect(resolveBrainCodexRouteSync()).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });

    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({
        subscriptionProfile: 'codex-only',
        brainCodexModel: 'gpt-5.6-terra',
        brainCodexEffort: 'max',
      }, null, 2)}\n`,
      'utf-8',
    );
    expect(resolveBrainCodexRouteSync()).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });

    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only', brainUseClaudeCli: true }, null, 2)}\n`,
      'utf-8',
    );
    expect(resolveBrainUseClaudeCliSync()).toBe(true);
    expect(resolveBrainUseCodexCliSync()).toBe(false);
  });

  it('suggests Opus after the second cheap-tier rerun and persists the marker', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only' }, null, 2)}\n`,
      'utf-8',
    );
    const packet = packetFixture();
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-single-sub-ladder',
      packets: [packet],
    });

    const result = await rerunWithFeedback({
      packetId: packet.id,
      feedback: 'Fix the review findings.',
    });
    expect(result.escalationSuggestion?.targetRuntime).toBe('claude-code');
    expect(result.escalationSuggestion?.targetModel).toBe('claude-opus-4-8');

    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    const persisted = currentMissionState().packets.find((candidate) => candidate.id === packet.id);
    expect(persisted?.attemptCount).toBe(2);
    expect(persisted?.tierEscalated).toBe(true);
    expect(persisted?.workerRouting?.selectedModel).toBe('claude-sonnet-5');
  });
});
