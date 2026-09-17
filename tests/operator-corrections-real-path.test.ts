/**
 * #2219 — operator rejection and steer reasons reach the next worker and the Brain.
 *
 * Real-path doctrine: the rejection is written by the ACTUAL approvals route
 * handler (constructed operator request, persisted approval + lane rows), and the
 * steer by the same `steered_packet` lane event the steer service persists. The
 * read side goes through the real `buildPacketPrompt` for a rerun of that packet
 * and the real Brain retrieval merge — never the formatter with direct arguments.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-corrections-repo-'));

const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const approvalsRoute = await import('@/app/api/panel/approvals/route');

afterAll(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

const REJECT_REASON = 'Missing error handling around the retry budget parser';
const STEER_MESSAGE = 'Keep the migration additive and do not rename the ledger column';

function packetFixture(id: string, workspaceTargetPath: string | null = null): OrchestratorPacket {
  return {
    id,
    workspaceTargetPath,
    branchTarget: null,
    referenceLabel: 'PKT-2219',
    title: 'feat harden the retry budget parser',
    summary: 'Harden parsing.',
    status: 'draft',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 1,
    lastEventAt: '2026-09-16T00:00:00.000Z',
    lastEventLabel: 'rerun',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  } as unknown as OrchestratorPacket;
}

async function rejectViaRoute(id: string, reason: string) {
  const response = await approvalsRoute.POST(new NextRequest('http://127.0.0.1/api/panel/approvals', {
    method: 'POST',
    headers: { host: '127.0.0.1', authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ id, action: 'reject', reason }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ ok: boolean }>;
}

function seedMergeCard(packetId: string) {
  const lane = createLane({ repoPath, branch: `o8/${packetId}`, runtime: 'codex', packetId });
  const approval = createApproval({
    source: 'runtime',
    runtime: 'codex',
    agent: 'codex',
    sessionKey: `codex-owned:${packetId}`,
    title: 'Merge packet into main',
    description: 'Merge the packet worktree into main',
    summary: 'two files changed',
    risk: 'medium',
    metadata: { Packet: packetId, Lane: lane.id },
  });
  return { lane, approval };
}

describe('#2219 rejection reason → next worker prompt (real reject route)', () => {
  it('a reason rejected through the route handler appears in the rerun prompt for that packet', async () => {
    const packetId = 'pkt-2219-reject';
    const { approval } = seedMergeCard(packetId);

    const payload = await rejectViaRoute(approval.id, REJECT_REASON);
    expect(payload.ok).toBe(true);
    expect(getApproval(approval.id)?.resolution?.note).toBe(REJECT_REASON);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Operator corrections for this packet');
    expect(prompt).toContain(REJECT_REASON);
  });

  it('an operator steer message recorded on the packet lane appears in the rerun prompt', async () => {
    const packetId = 'pkt-2219-steer';
    const { lane } = seedMergeCard(packetId);
    recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId,
      source: 'operator',
      message: STEER_MESSAGE,
      clientMutationId: 'steer-2219',
    });

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Operator corrections for this packet');
    expect(prompt).toContain(STEER_MESSAGE);
  });

  it('a different packet on the same repo sees the rejection in its repo context block', async () => {
    const prompt = await buildPacketPrompt(packetFixture('pkt-2219-sibling', repoPath), []);
    expect(prompt).toContain('## Recent Operator Corrections');
    expect(prompt).toContain(REJECT_REASON);
    expect(prompt).not.toContain('Operator corrections for this packet');
  });

  it('a packet with no rejection or steer carries no corrections block (negative control)', async () => {
    const prompt = await buildPacketPrompt(packetFixture('pkt-2219-clean'), []);
    expect(prompt).not.toContain('Operator corrections for this packet');
  });
});

describe('#2219 rejection reason → Engineering Brain retrieval', () => {
  it('the corrections retriever surfaces the route-recorded reason for a question about the repo', async () => {
    const packetId = 'pkt-2219-brain';
    const { approval } = seedMergeCard(packetId);
    await rejectViaRoute(approval.id, 'Retry budget parser must reject negative counts');

    const { retrieveAll, unionMerge } = await import('@/lib/cortex/qa/retrieve');
    const results = await retrieveAll({
      question: 'why did the operator reject the retry budget parser change?',
      repoPath,
    });
    const corrections = results.find((result) => result.retriever === 'corrections');
    expect(corrections?.rows.map((row) => row.fields.body)).toContain(
      'Retry budget parser must reject negative counts',
    );

    const merged = unionMerge(results);
    const cited = merged.find((row) => row.citation.kind === 'correction'
      && row.fields.body === 'Retry budget parser must reject negative counts');
    expect(cited?.citation.table).toBe('approvals');
    expect(cited?.fields.packetId).toBe(packetId);
  });
});
