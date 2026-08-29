import { describe, expect, it } from 'vitest';

import { normalizeGitRemote, parsePacketReceipt } from './verify-receipt';

function receiptWithRepo(repo: Record<string, unknown>): unknown {
  return {
    schema: 'o8/packet-receipt/v1',
    receiptId: 'receipt-test',
    packetId: 'packet-test',
    packetTitle: 'Receipt contract test',
    laneId: 'lane-test',
    repo,
    disposition: {
      kind: 'merged',
      mergeCommit: 'a'.repeat(40),
      headSha: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      evidenceKind: 'merge_command',
      releasedAt: '2026-08-29T20:00:00.000Z',
    },
    reviews: [],
    approvals: [],
    runtime: 'codex',
    model: null,
    createdAt: '2026-08-29T20:00:01.000Z',
    keyId: '0123456789abcdef',
    signature: 'signature',
  };
}

describe('packet receipt repository contract', () => {
  it('accepts a repository name and rejects the legacy local path field', () => {
    expect(parsePacketReceipt(receiptWithRepo({
      name: 'o8',
      remote: 'example.test/operator/o8',
      baseBranch: 'main',
    }))).not.toBeNull();
    expect(parsePacketReceipt(receiptWithRepo({
      path: '/home/operator/o8',
      baseBranch: 'main',
    }))).toBeNull();
  });

  it('keeps only host, owner, and repository name from network remotes', () => {
    expect(normalizeGitRemote('https://user:secret@Example.test/owner/repo.git'))
      .toBe('example.test/owner/repo');
    expect(normalizeGitRemote('git@example.test:owner/repo.git'))
      .toBe('example.test/owner/repo');
    expect(normalizeGitRemote('ssh://git@example.test/owner/repo.git'))
      .toBe('example.test/owner/repo');
  });

  it('omits local and file remotes instead of signing a machine path', () => {
    expect(normalizeGitRemote('/home/operator/repo.git')).toBeNull();
    expect(normalizeGitRemote('file:///home/operator/repo.git')).toBeNull();
  });
});
