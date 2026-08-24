import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { listApprovalEvents, listApprovalsForContext, recordOrchestratorReview } from '@/lib/approvals/store';
import { createLane, getLaneEvents } from '@/lib/lane/registry';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';
import { parseCodexAutoReviewVerdict, recordCodexAutoReviewVerdict } from './codex-auto-review-verdict';

/**
 * A stubbed reviewer runtime. `recordCodexAutoReviewVerdict` drives the real
 * `runReviewerTurnWithQuotaFallback` seam for its #1812 retry, so passing a
 * backend here exercises the production retry path end to end.
 */
function stubReviewerBackend(text: string): OrchestratorBackend {
  return {
    id: 'codex',
    label: 'Codex',
    peekSession: () => ({ sessionName: 'test-codex', status: 'ready' }),
    ensureSession: () => ({ sessionName: 'test-codex', status: 'ready' }),
    sendTurn: vi.fn(async (_repo: string, _prompt: string, onEvent) => {
      onEvent({ type: 'text', text });
      onEvent({ type: 'done', cost: null });
    }),
  } as OrchestratorBackend;
}

function makeReviewLane(repoPath: string, packetId: string) {
  return createLane({
    repoPath,
    worktreePath: repoPath,
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    label: 'Codex review test',
    packetId,
    sessionKey: `codex:${packetId}`,
  });
}

function orchestratorReviews(lane: { id: string; sessionKey?: string | null }, packetId: string) {
  return listApprovalsForContext({
    packetId,
    laneId: lane.id,
    sessionKey: lane.sessionKey ?? undefined,
    projectId: null,
  }).filter((candidate) => candidate.toolName === 'orchestrator_review');
}

function createGitRepo() {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-codex-review-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# codex review test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', [
    '-c',
    'user.name=o8 test',
    '-c',
    'user.email=o8-test@example.com',
    'commit',
    '-m',
    'init',
  ], { cwd: repoPath });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  return { repoPath, head };
}

describe('Codex auto-review verdict fallback', () => {
  it('records a Codex verdict as a real orchestrator_review approval row', async () => {
    const { repoPath, head } = createGitRepo();
    const packetId = `pkt-codex-review-${Date.now()}`;
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/codex-review-test',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Codex review test',
      packetId,
      sessionKey: `codex:${packetId}`,
    });

    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      requiresSecondPass: false,
      reviewTurnId: 'review-turn-codex-verdict-test',
      rawText: [
        'Review complete.',
        `CODEX_AUTO_REVIEW: {"approved":true,"findings":[],"contractCoverageEvidence":{"contractVersion":1,"headSha":"${head}","entries":[{"requirementId":"R1","productionPath":"README.md","anchor":"line 1","verification":"read rendered content"}]}}`,
      ].join('\n'),
    });

    expect(recorded?.event?.type).toBe('orchestrator_review');

    const approval = listApprovalsForContext({
      packetId,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
      projectId: null,
    }).find((candidate) => candidate.toolName === 'orchestrator_review');

    expect(approval).toBeTruthy();
    expect(approval?.status).toBe('approved');
    expect(approval?.risk).toBe('low');
    expect(approval?.metadata).toMatchObject({
      Packet: packetId,
      Lane: lane.id,
      Runtime: 'codex',
      'Reviewed HEAD': head,
      Reviewer: 'codex',
    });
    expect(approval?.args).toMatchObject({
      packetId,
      approved: true,
      findings: [],
      reviewedHeadSha: head,
      requiresSecondPass: false,
      secondPassAgreed: false,
      reviewTurnId: 'review-turn-codex-verdict-test',
      reviewTurnOutcome: 'completed',
      contractCoverageEvidence: {
        contractVersion: 1,
        headSha: head,
        entries: [{
          requirementId: 'R1',
          productionPath: 'README.md',
          anchor: 'line 1',
          verification: 'read rendered content',
        }],
      },
    });

    const events = approval ? listApprovalEvents(approval.id) : [];
    expect(events.some((event) => (
      event.type === 'orchestrator_review'
      && event.actor === 'orchestrator'
      && event.approved === true
      && event.reviewer === 'codex'
      && event.reviewedHeadSha === head
    ))).toBe(true);
  });

  it('keeps unstructured Codex verdict text for operator attention without blaming the packet', () => {
    const verdict = parseCodexAutoReviewVerdict('Looks fine to me, approve.');

    expect(verdict.reviewUnavailable).toBe(true);
    expect(verdict.approved).toBe(false);
    expect(verdict.parseWarning).toBe('missing CODEX_AUTO_REVIEW JSON payload');
    expect(verdict.findings).toEqual([]);
    expect(verdict.rawText).toContain('Looks fine to me');
  });
});

// #1812 — the reviewer preambling ("I'm applying the q-communication skill …")
// used to reject clean packets. These drive the REAL record path (parse →
// stricter retry turn through runReviewerTurnWithQuotaFallback → persistence)
// with a stubbed reviewer runtime.
describe('Codex auto-review parse failure is a reviewer failure, not a packet rejection (#1812)', () => {
  it('does not parse or retry prose after the same turn already submitted a durable verdict', async () => {
    const { repoPath, head } = createGitRepo();
    const packetId = `pkt-codex-tool-verdict-${Date.now()}`;
    const lane = makeReviewLane(repoPath, packetId);
    const reviewTurnId = 'review-turn-tool-verdict';
    recordOrchestratorReview(packetId, {
      findings: [],
      reviewer: 'codex',
      approved: true,
      reviewedHeadSha: head,
      reviewTurnId,
      reviewTurnOutcome: 'completed',
    });
    const retryBackend = stubReviewerBackend(
      'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}',
    );

    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      requiresSecondPass: false,
      reviewTurnId,
      rawText: 'The verdict was submitted through the review tool.',
      retry: {
        reviewPrompt: 'Review the complete packet.',
        threadId: `auto-review-${lane.id}-verdict-retry`,
        initialBackend: retryBackend,
        backendResolver: () => retryBackend,
      },
    });

    expect(recorded).toBeNull();
    expect(vi.mocked(retryBackend.sendTurn)).not.toHaveBeenCalled();
    const approvals = orchestratorReviews(lane, packetId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.args?.reviewTurnId).toBe(reviewTurnId);
  });

  it('records review_unavailable and leaves an existing verdict untouched when both turns are prose', async () => {
    const { repoPath, head } = createGitRepo();
    const packetId = `pkt-codex-prose-${Date.now()}`;
    const lane = makeReviewLane(repoPath, packetId);

    // An operator verdict already stands on this packet.
    recordOrchestratorReview(packetId, {
      findings: [],
      reviewer: 'operator',
      approved: true,
      reviewedHeadSha: head,
    });
    const before = orchestratorReviews(lane, packetId);
    expect(before).toHaveLength(1);

    const retryBackend = stubReviewerBackend('I am applying the q-communication skill and will report shortly.');
    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      requiresSecondPass: false,
      reviewTurnId: 'review-turn-prose-only',
      rawText: "I'm applying the `q-communication` skill … I'll apply the `ship` skill next.",
      retry: {
        reviewPrompt: 'Review the complete packet.',
        threadId: `auto-review-${lane.id}-verdict-retry`,
        initialBackend: retryBackend,
        backendResolver: () => retryBackend,
      },
    });

    expect(recorded?.reviewUnavailable).toBe(true);
    expect(recorded?.event).toBeNull();
    expect(recorded?.verdict.findings).toEqual([]);

    // The stricter retry actually ran, once, with the tightened contract.
    const sendTurn = vi.mocked(retryBackend.sendTurn);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(String(sendTurn.mock.calls[0]?.[1])).toContain('Verdict format retry');

    // No rejection was written against the packet, and the prior verdict stands.
    const after = orchestratorReviews(lane, packetId);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('approved');
    expect(after[0]?.args?.approved).toBe(true);
    expect(after[0]?.args?.findings).toEqual([]);
    expect(after.some((approval) => approval.args?.approved === false)).toBe(false);

    // The reviewer outage is on the lane ledger with the raw text for debugging.
    const unavailable = getLaneEvents(lane.id).find((event) => event.verb === 'review_unavailable');
    expect(unavailable?.payload).toMatchObject({
      surface: 'auto-review',
      reviewer: 'codex',
      packetId,
      reason: 'missing CODEX_AUTO_REVIEW JSON payload',
      attempts: 2,
    });
    expect(String(unavailable?.payload.rawText)).toContain('q-communication');
  });

  it('parses the trailing JSON object when the reviewer preambles before it', async () => {
    const { repoPath, head } = createGitRepo();
    const packetId = `pkt-codex-preamble-${Date.now()}`;
    const lane = makeReviewLane(repoPath, packetId);

    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      requiresSecondPass: false,
      reviewTurnId: 'review-turn-preamble-json',
      rawText: [
        "I'm applying the `q-communication` skill before answering.",
        'Gates are green: typecheck clean, suite clean.',
        `{"approved":true,"findings":[],"contractCoverageEvidence":{"contractVersion":1,"headSha":"${head}","entries":[{"requirementId":"R1","productionPath":"README.md","anchor":"line 1","verification":"read rendered content"}]}}`,
      ].join('\n'),
      retry: {
        reviewPrompt: 'Review the complete packet.',
        threadId: `auto-review-${lane.id}-verdict-retry`,
        initialBackend: stubReviewerBackend('should not be reached'),
      },
    });

    expect(recorded?.reviewUnavailable).toBe(false);
    expect(recorded?.verdict.approved).toBe(true);
    expect(recorded?.verdict.findings).toEqual([]);
    expect(recorded?.verdict.parseWarning).toBeUndefined();
    expect(getLaneEvents(lane.id).some((event) => event.verb === 'review_unavailable')).toBe(false);

    const approvals = orchestratorReviews(lane, packetId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('approved');
    expect(approvals[0]?.args?.findings).toEqual([]);
  });

  it('accepts the verdict from the stricter retry turn after a prose-only first turn', async () => {
    const { repoPath, head } = createGitRepo();
    const packetId = `pkt-codex-retry-${Date.now()}`;
    const lane = makeReviewLane(repoPath, packetId);

    const retryBackend = stubReviewerBackend(
      `CODEX_AUTO_REVIEW: {"approved":false,"findings":[{"file":"src/example.ts","line":12,"severity":"bug","description":"off-by-one in the loop bound","status":"deferred"}]}`,
    );
    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      requiresSecondPass: false,
      reviewTurnId: 'review-turn-first-attempt',
      rawText: 'Applying the review skill now — standby.',
      retry: {
        reviewPrompt: 'Review the complete packet.',
        threadId: `auto-review-${lane.id}-verdict-retry`,
        initialBackend: retryBackend,
        backendResolver: () => retryBackend,
      },
    });

    expect(recorded?.reviewUnavailable).toBe(false);
    expect(recorded?.verdict.approved).toBe(false);
    expect(recorded?.verdict.findings).toHaveLength(1);
    expect(recorded?.verdict.findings[0]).toMatchObject({
      file: 'src/example.ts',
      severity: 'bug',
    });
    // A real finding — never the synthetic `codex-auto-review` parser finding.
    expect(recorded?.verdict.findings.some((finding) => finding.file === 'codex-auto-review')).toBe(false);
    expect(recorded?.reviewedHeadSha).toBe(head);

    const approvals = orchestratorReviews(lane, packetId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.args?.approved).toBe(false);
    expect(approvals[0]?.args?.reviewTurnId).not.toBe('review-turn-first-attempt');
  });
});
