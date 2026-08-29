import { describe, expect, it } from 'vitest';

import type { ArtifactRecord } from '@/lib/artifacts/store';
import type { StoredPacketReceipt } from './packet-receipt';
import type { PacketReceipt } from './types';
import {
  resolveTruthGrantScope,
  resolveTruthQuery,
  type TruthPacketRecord,
  type TruthQueryStores,
} from './truth-query';

const NOW = new Date('2026-08-29T22:00:00.000Z');

function receiptFixture(input: {
  artifactId: string;
  packetId: string;
  repoName: string;
  repoRemote: string;
  repoPath: string;
  createdAt: string;
  disposition?: PacketReceipt['disposition'];
  approvals?: PacketReceipt['approvals'];
}): StoredPacketReceipt {
  const receipt: PacketReceipt = {
    schema: 'o8/packet-receipt/v1',
    receiptId: `receipt-${input.artifactId}`,
    packetId: input.packetId,
    packetTitle: `Title for ${input.packetId}`,
    laneId: `lane-${input.packetId}`,
    repo: {
      name: input.repoName,
      remote: input.repoRemote,
      baseBranch: 'main',
    },
    disposition: input.disposition ?? {
      kind: 'merged',
      mergeCommit: `merge-${input.packetId}`,
      headSha: `head-${input.packetId}`,
      tree: `tree-${input.packetId}`,
      evidenceKind: 'merge_command',
      releasedAt: input.createdAt,
    },
    reviews: [],
    approvals: input.approvals ?? [],
    runtime: 'codex',
    model: 'test-model',
    createdAt: input.createdAt,
    keyId: '0123456789abcdef',
    signature: `signature-${input.packetId}`,
  };
  const artifact: ArtifactRecord = {
    id: input.artifactId,
    kind: 'receipt',
    source: 'review-boundary',
    laneId: receipt.laneId,
    packetId: receipt.packetId,
    repoPath: input.repoPath,
    prNumber: null,
    threadId: null,
    label: 'Signed packet receipt',
    phase: null,
    pairId: null,
    relPath: `artifacts/${input.packetId}/${input.artifactId}.json`,
    mimeType: 'application/json',
    width: null,
    height: null,
    bytes: 1,
    ghCommentUrl: null,
    capturedAt: input.createdAt,
    createdAt: input.createdAt,
  };
  return { artifact, receipt, rawReceiptJson: JSON.stringify(receipt) };
}

function storesFixture(
  receipts: StoredPacketReceipt[],
  packets: TruthPacketRecord[] = [],
  mirroredIssues: TruthQueryStores['listMirroredIssues'] = () => [],
): TruthQueryStores {
  return {
    listReceipts: (packetId) => packetId
      ? receipts.filter((stored) => stored.receipt.packetId === packetId)
      : receipts,
    listPackets: () => packets,
    listMirroredIssues: mirroredIssues,
    listRegisteredRepos: async () => [],
    now: () => NOW,
  };
}

describe('resolveTruthQuery', () => {
  it('returns merged receipts for one repository since a timestamp and cursors by artifact createdAt', () => {
    const first = receiptFixture({
      artifactId: 'artifact-a-1',
      packetId: 'packet-a-1',
      repoName: 'repo-a',
      repoRemote: 'example.test/team/repo-a',
      repoPath: '/repos/repo-a',
      createdAt: '2026-08-29T20:00:00.000Z',
    });
    const second = receiptFixture({
      artifactId: 'artifact-a-2',
      packetId: 'packet-a-2',
      repoName: 'repo-a',
      repoRemote: 'example.test/team/repo-a',
      repoPath: '/repos/repo-a',
      createdAt: '2026-08-29T21:00:00.000Z',
    });
    const otherRepo = receiptFixture({
      artifactId: 'artifact-b-1',
      packetId: 'packet-b-1',
      repoName: 'repo-b',
      repoRemote: 'example.test/team/repo-b',
      repoPath: '/repos/repo-b',
      createdAt: '2026-08-29T20:30:00.000Z',
    });
    const stores = storesFixture([first, second, otherRepo]);

    const pageOne = resolveTruthQuery({
      kind: 'merged-since',
      repo: 'example.test/team/repo-a',
      since: '2026-08-29T19:00:00.000Z',
      limit: 1,
    }, {}, stores);
    expect(pageOne.answers).toHaveLength(1);
    expect(pageOne.answers[0]!.receipt).toBe(first.receipt);
    expect(pageOne.answers[0]!.receiptRaw).toBe(first.rawReceiptJson);
    expect(pageOne.nextCursor).toEqual(expect.any(String));

    const pageTwo = resolveTruthQuery({
      kind: 'merged-since',
      repo: 'repo-a',
      since: '2026-08-29T19:00:00.000Z',
      limit: 1,
      cursor: pageOne.nextCursor,
    }, {}, stores);
    expect(pageTwo.answers.map((answer) => answer.artifactId)).toEqual(['artifact-a-2']);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it('resolves packet queries by packet id or the mission packet issue number first', () => {
    const stored = receiptFixture({
      artifactId: 'artifact-issue',
      packetId: 'packet-issue',
      repoName: 'repo-a',
      repoRemote: 'example.test/team/repo-a',
      repoPath: '/repos/repo-a',
      createdAt: '2026-08-29T20:00:00.000Z',
    });
    const stores = storesFixture([stored], [{
      id: 'packet-issue',
      issueNumber: 1998,
      issueUrl: 'https://example.test/team/repo-a/issues/1998',
      referenceLabel: '#1998',
      repoPath: '/repos/repo-a',
    }]);

    expect(resolveTruthQuery({ kind: 'packet', packetId: 'packet-issue' }, {}, stores)
      .answers.map((answer) => answer.artifactId)).toEqual(['artifact-issue']);
    expect(resolveTruthQuery({ kind: 'packet', issueNumber: 1998 }, {}, stores)
      .answers.map((answer) => answer.artifactId)).toEqual(['artifact-issue']);
  });

  it('falls back to the GitHub issue mirror when the packet record has only an issue URL', () => {
    const stored = receiptFixture({
      artifactId: 'artifact-mirror',
      packetId: 'packet-mirror',
      repoName: 'repo-a',
      repoRemote: 'example.test/team/repo-a',
      repoPath: '/repos/repo-a',
      createdAt: '2026-08-29T20:00:00.000Z',
    });
    const stores = storesFixture([stored], [{
      id: 'packet-mirror',
      issueNumber: null,
      issueUrl: 'https://example.test/team/repo-a/issues/77',
      referenceLabel: '#77',
      repoPath: '/repos/repo-a',
    }], (issueNumber) => [{
      repoFullName: 'team/repo-a',
      number: issueNumber,
      title: 'Mirrored issue',
      url: 'https://example.test/team/repo-a/issues/77',
    }]);

    expect(resolveTruthQuery({ kind: 'packet', issueNumber: 77 }, {}, stores)
      .answers.map((answer) => answer.receipt.packetId)).toEqual(['packet-mirror']);
  });

  it('returns approval decisions with the same stored receipt object', () => {
    const stored = receiptFixture({
      artifactId: 'artifact-approval',
      packetId: 'packet-approval',
      repoName: 'repo-a',
      repoRemote: 'example.test/team/repo-a',
      repoPath: '/repos/repo-a',
      createdAt: '2026-08-29T20:00:00.000Z',
      approvals: [{
        id: 'approval-1',
        title: 'Merge packet',
        principal: 'operator',
        decision: 'approved',
        at: '2026-08-29T19:59:00.000Z',
      }],
    });

    const result = resolveTruthQuery({ kind: 'approvals', packetId: 'packet-approval' }, {}, storesFixture([stored]));
    expect(result.answers[0]!.receipt).toBe(stored.receipt);
    expect(result.answers[0]!.summary).toContain('operator approved');
    expect(result.asOf).toBe(NOW.toISOString());
  });

  it('binds an explicit name grant to one registered path and rejects collisions', async () => {
    const registered = receiptFixture({
      artifactId: 'artifact-name-registered',
      packetId: 'packet-name-registered',
      repoName: 'repo',
      repoRemote: '',
      repoPath: '/left/repo',
      createdAt: '2026-08-29T20:00:00.000Z',
    });
    const colliding = receiptFixture({
      artifactId: 'artifact-name-colliding',
      packetId: 'packet-name-colliding',
      repoName: 'repo',
      repoRemote: '',
      repoPath: '/right/repo',
      createdAt: '2026-08-29T20:01:00.000Z',
    });
    const stores = storesFixture([registered, colliding]);
    stores.listRegisteredRepos = async () => [{ name: 'repo', repoPath: '/left/repo' }];
    const scope = await resolveTruthGrantScope(['name:repo'], stores);
    expect(scope.receiptCovered(registered)).toBe(true);
    expect(scope.receiptCovered(colliding)).toBe(false);

    stores.listRegisteredRepos = async () => [
      { name: 'repo', repoPath: '/left/repo' },
      { name: 'repo', repoPath: '/right/repo' },
    ];
    await expect(resolveTruthGrantScope(['name:repo'], stores)).rejects.toMatchObject({
      code: 'grant_ambiguous',
      message: expect.stringContaining('matches 2 registered repository paths'),
    });
  });
});
