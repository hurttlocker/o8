import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  buildWorkerOutcomeOwnershipPromptV1,
  OUTCOME_OWNERSHIP_HEADING_V1,
} from '@/lib/prompts/v1';
import { OPENCLAW_ORCHESTRATOR_PROMPT } from '@/lib/lane/orchestrator-backends/openclaw';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-outcome-ownership-'));

const { buildPacketPrompt } = await import('./packet-prompt');

function packet(runtime: OrchestratorRuntime, readOnly = false): OrchestratorPacket {
  return {
    id: `pkt-outcome-${runtime}-${readOnly ? 'read' : 'write'}`,
    referenceLabel: 'PKT-1',
    title: 'Close the reported behavior gap',
    summary: 'Trace the real entry point and implement the smallest complete remedy.',
    workspaceTargetPath: null,
    branchTarget: 'main',
    runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    launchContext: readOnly ? {
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      workMode: 'read-only',
    } : undefined,
  };
}

describe('outcome ownership prompt reachability', () => {
  it('injects the same worker kernel through the real packet assembler for every dispatchable runtime', async () => {
    for (const runtime of listDispatchableRuntimes()) {
      const prompt = await buildPacketPrompt(packet(runtime), []);
      expect(prompt, runtime).toContain(OUTCOME_OWNERSHIP_HEADING_V1);
      expect(prompt, runtime).toContain('real entry point');
      expect(prompt, runtime).toContain('implementation-ready for independent review');
      expect(prompt, runtime).toContain('Outcome, Evidence, Residual, and Decision');
    }
  });

  it('keeps the read-only overlay non-mutating through the real packet assembler', async () => {
    const prompt = await buildPacketPrompt(packet('codex', true), []);

    expect(prompt).toContain('This packet is read-only');
    expect(prompt).toContain('evidence-backed diagnosis, decision, or handoff');
    expect(prompt).toContain('recommend the smallest executable protection precisely; do not install it');
    expect(prompt).not.toContain('Add proportionate recurrence protection');
    expect(prompt).not.toContain('A committed, typecheck-clean patch is implementation-ready');
    expect(prompt).not.toContain('git add -A && git commit');
  });

  it('keeps the role overlays distinct at the shared builder', () => {
    expect(buildWorkerOutcomeOwnershipPromptV1(false)).toContain('implementation-ready');
    expect(buildWorkerOutcomeOwnershipPromptV1(true)).toContain('Do not edit, commit, mutate');
  });

  it('reaches the OpenClaw orchestrator path without granting mutation authority', () => {
    expect(OPENCLAW_ORCHESTRATOR_PROMPT).toContain('## Outcome ownership');
    expect(OPENCLAW_ORCHESTRATOR_PROMPT).toContain('Dispatch is a recorded handoff');
    expect(OPENCLAW_ORCHESTRATOR_PROMPT).toContain('Read-only and diagnostic work remains non-mutating');
  });
});
