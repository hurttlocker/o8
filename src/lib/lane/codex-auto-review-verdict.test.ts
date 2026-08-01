import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listApprovalEvents, listApprovalsForContext } from '@/lib/approvals/store';
import { createLane } from '@/lib/lane/registry';
import { parseCodexAutoReviewVerdict, recordCodexAutoReviewVerdict } from './codex-auto-review-verdict';

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
        'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}',
      ].join('\n'),
    });

    expect(recorded?.event.type).toBe('orchestrator_review');

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

  it('keeps unstructured Codex verdict text for operator attention', () => {
    const verdict = parseCodexAutoReviewVerdict('Looks fine to me, approve.');

    expect(verdict.approved).toBe(false);
    expect(verdict.parseWarning).toBe('missing CODEX_AUTO_REVIEW JSON payload');
    expect(verdict.findings[0]).toMatchObject({
      file: 'codex-auto-review',
      severity: 'rule_violation',
      resolution: 'deferred',
    });
    expect(verdict.findings[0]?.description).toContain('Looks fine to me');
  });
});
