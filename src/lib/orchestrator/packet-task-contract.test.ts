import { describe, expect, it } from 'vitest';

import {
  buildPacketTaskContractInstructions,
  formatPacketTaskContractForReview,
  normalizePacketTaskContract,
  PACKET_TASK_CONTRACT_TAG_END,
  PACKET_TASK_CONTRACT_TAG_START,
  parsePacketTaskContract,
  stripPacketTaskContract,
} from './packet-task-contract';

const contract = {
  version: 1 as const,
  requirements: [{
    id: 'R1',
    source: 'The issue requires a pre-edit contract.',
    expectedBehavior: 'The worker records requirements before writes.',
    productionPath: 'packet prompt -> runtime transcript -> completion context',
    verification: 'focused prompt and parser tests',
  }],
  smallestRoute: [{
    path: 'src/lib/orchestrator/packet-task-contract.ts',
    requirements: ['R1'],
    reason: 'One parser owns the contract boundary.',
  }],
  exclusions: ['No candidate-selection implementation'],
};

describe('packet task contract', () => {
  it('parses and normalizes a machine-readable transcript block', () => {
    const text = [
      'I inspected the task and production path.',
      `${PACKET_TASK_CONTRACT_TAG_START}${JSON.stringify(contract)}${PACKET_TASK_CONTRACT_TAG_END}`,
    ].join('\n');

    expect(parsePacketTaskContract(text)).toEqual(contract);
    expect(stripPacketTaskContract(text)).toBe('I inspected the task and production path.');
  });

  it('rejects contracts with unmapped requirements', () => {
    expect(normalizePacketTaskContract({
      ...contract,
      requirements: [
        ...contract.requirements,
        {
          id: 'R2',
          source: 'Second requirement',
          expectedBehavior: 'Second behavior',
          productionPath: 'second path',
          verification: 'second test',
        },
      ],
    })).toBeNull();
  });

  it('keeps process obligations separate from changed-file requirements', () => {
    const withProcess = {
      ...contract,
      processConstraints: [{
        id: 'P1',
        source: 'Commit the edit and report the changed file.',
        expectedBehavior: 'The commit and report both exist.',
        verification: 'git show HEAD and worker transcript',
      }],
    };
    expect(normalizePacketTaskContract(withProcess)).toEqual(withProcess);
    expect(formatPacketTaskContractForReview(withProcess)).toContain('P1: The commit and report both exist.');
    expect(buildPacketTaskContractInstructions().join('\n')).toContain('processConstraints');
    expect(normalizePacketTaskContract({
      ...withProcess,
      processConstraints: [...withProcess.processConstraints, { ...withProcess.processConstraints[0], id: 'R1' }],
    })).toBeNull();
  });

  it('normalizes worker-authored fields to single-line review evidence', () => {
    expect(normalizePacketTaskContract({
      ...contract,
      requirements: [{
        ...contract.requirements[0],
        source: 'Task line one\nTask line two',
      }],
    })?.requirements[0].source).toBe('Task line one Task line two');
  });

  it('renders the contract for review with requirement and route evidence', () => {
    const rendered = formatPacketTaskContractForReview(contract);
    expect(rendered).toContain('R1: The worker records requirements before writes.');
    expect(rendered).toContain('worker-authored evidence');
    expect(rendered).toContain('packet prompt -> runtime transcript -> completion context');
    expect(rendered).toContain('packet-task-contract.ts -> R1');
  });

  it('keeps pre-edit ordering and immutable-contract rules in the worker instructions', () => {
    const notesPath = '.o8/packet-artifacts/pkt-1/implementation-notes.md';
    const prompt = buildPacketTaskContractInstructions(notesPath).join('\n');
    expect(prompt).toContain('Before using any write/edit tool');
    expect(prompt).toContain(PACKET_TASK_CONTRACT_TAG_START);
    expect(prompt).toContain('Treat the first contract as immutable');
    expect(prompt).toContain('Every file-backed requirement ID must appear in smallestRoute');
    expect(prompt).toContain(notesPath);
  });
});
