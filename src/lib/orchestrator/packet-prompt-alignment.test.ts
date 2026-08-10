/**
 * Alignment-block de-dup in the worker prompt.
 *
 * Both the explicit Huddle section and the single-sub cheap-tier Advisor section
 * instruct the worker to do the alignment turn BEFORE editing. A packet that is
 * both huddle:true AND advisor-armed used to receive both overlapping blocks;
 * buildPacketPrompt must now emit exactly one (huddle wins; advisor only when
 * huddle is off). Driven through the real prompt assembler, not the resolvers.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { OrchestratorPacket } from './types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-pkt-align-'));

const { buildPacketPrompt } = await import('./packet-prompt');
const { HUDDLE_PROMPT_SECTION } = await import('./huddle-access');
const { ADVISOR_PROMPT_SECTION } = await import('./advisor-access');

function minimalPacket(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: `pkt-align-${Math.random().toString(36).slice(2)}`,
    referenceLabel: 'PKT-1',
    title: 'feat: test packet',
    summary: 'Test packet summary',
    workspaceTargetPath: null,
    branchTarget: 'main',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    ...overrides,
  } as OrchestratorPacket;
}

async function withCheapTierProfile<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.O8_SUBSCRIPTION_PROFILE;
  process.env.O8_SUBSCRIPTION_PROFILE = 'claude-only';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.O8_SUBSCRIPTION_PROFILE;
    else process.env.O8_SUBSCRIPTION_PROFILE = prev;
  }
}

describe('buildPacketPrompt alignment de-dup', () => {
  it('a both-armed packet (huddle + advisor) gets exactly one alignment block — huddle wins', async () => {
    await withCheapTierProfile(async () => {
      // claude-code runtime + null model under claude-only → advisor-armed too.
      const prompt = await buildPacketPrompt(
        minimalPacket({ huddle: true, runtime: 'claude-code', assignedModel: null }),
        [],
      );
      expect(prompt).toContain(HUDDLE_PROMPT_SECTION);
      expect(prompt).not.toContain(ADVISOR_PROMPT_SECTION);
    });
  });

  it('advisor-armed alone (huddle off) still gets the advisor block, not the huddle block', async () => {
    await withCheapTierProfile(async () => {
      const prompt = await buildPacketPrompt(
        minimalPacket({ huddle: false, runtime: 'claude-code', assignedModel: null }),
        [],
      );
      expect(prompt).toContain(ADVISOR_PROMPT_SECTION);
      expect(prompt).not.toContain(HUDDLE_PROMPT_SECTION);
    });
  });

  it('read-only work gets an inspection contract without write, alignment, or commit instructions', async () => {
    await withCheapTierProfile(async () => {
      const prompt = await buildPacketPrompt(
        minimalPacket({
          huddle: true,
          runtime: 'claude-code',
          assignedModel: null,
          launchContext: {
            source: 'cli',
            presentation: 'split',
            repoContext: 'transient',
            workMode: 'read-only',
          },
        }),
        [],
      );
      expect(prompt).toContain('Read-only packet: inspect the repository');
      expect(prompt).not.toContain(HUDDLE_PROMPT_SECTION);
      expect(prompt).not.toContain(ADVISOR_PROMPT_SECTION);
      expect(prompt).not.toContain('git add -A && git commit');
    });
  });
});
