import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { OrchestratorPacket, OrchestratorRuntime } from './types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-pkt-contract-'));

const { buildPacketPrompt } = await import('./packet-prompt');
const { PACKET_TASK_CONTRACT_TAG_START } = await import('./packet-task-contract');

function packet(
  runtime: OrchestratorRuntime,
  required: boolean,
  overrides: Partial<OrchestratorPacket> = {},
): OrchestratorPacket {
  return {
    id: `pkt-contract-${runtime}-${required}`,
    referenceLabel: 'PKT-1',
    title: 'feat: contract-first quality',
    summary: 'Require an auditable plan before implementation.',
    workspaceTargetPath: null,
    branchTarget: 'main',
    runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    taskContractRequired: required,
    ...overrides,
  };
}

describe('buildPacketPrompt task contract', () => {
  it.each(['codex', 'claude-code'] as const)('injects the same contract gate for %s', async (runtime) => {
    const prompt = await buildPacketPrompt(packet(runtime, true), []);
    expect(prompt).toContain('Pre-edit task contract:');
    expect(prompt).toContain(PACKET_TASK_CONTRACT_TAG_START);
    expect(prompt).toContain('Before using any write/edit tool');
  });

  it('does not retroactively arm legacy packets', async () => {
    const prompt = await buildPacketPrompt(packet('codex', false), []);
    expect(prompt).not.toContain('Pre-edit task contract:');
    expect(prompt).not.toContain(PACKET_TASK_CONTRACT_TAG_START);
  });

  it('injects one sealed contract and the assigned quality-search role', async () => {
    const taskContract = {
      version: 1 as const,
      requirements: [{
        id: 'R1',
        source: 'Cover the real route.',
        expectedBehavior: 'The route works.',
        productionPath: 'route -> service',
        verification: 'focused test',
      }],
      smallestRoute: [{
        path: 'src/route.ts',
        requirements: ['R1'],
        reason: 'The route owns the behavior.',
      }],
      exclusions: [],
    };
    const prompt = await buildPacketPrompt(packet('codex', true, {
      taskContract,
      qualitySearch: { version: 1, role: 'robustness_complete', repairAttempts: 0 },
    }), []);

    expect(prompt).toContain('Sealed pre-edit task contract:');
    expect(prompt).toContain(JSON.stringify(taskContract));
    expect(prompt).not.toContain(PACKET_TASK_CONTRACT_TAG_START);
    expect(prompt).toContain('Quality-search candidate role: robustness route.');
  });
});
