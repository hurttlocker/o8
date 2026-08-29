import { describe, expect, it } from 'vitest';

import {
  buildDiscardedPacketDisposition,
  buildMergedPacketDisposition,
} from './disposition';

describe('packet receipt dispositions', () => {
  it('builds merged evidence from the persisted release payload', () => {
    expect(buildMergedPacketDisposition({
      releaseStatePayload: {
        source: 'approve_and_merge',
        mergeCommit: 'merge-sha',
        headSha: 'head-sha',
        evidenceKind: 'merge_command',
        releasedAt: '2026-08-29T19:00:00.000Z',
      },
      tree: 'tree-sha',
      expectedMergeCommit: 'merge-sha',
    })).toEqual({
      kind: 'merged',
      mergeCommit: 'merge-sha',
      headSha: 'head-sha',
      tree: 'tree-sha',
      evidenceKind: 'merge_command',
      releasedAt: '2026-08-29T19:00:00.000Z',
    });
  });

  it('rejects a merge result that differs from persisted release truth', () => {
    expect(() => buildMergedPacketDisposition({
      releaseStatePayload: {
        mergeCommit: 'persisted-sha',
        releasedAt: '2026-08-29T19:00:00.000Z',
      },
      tree: 'tree-sha',
      expectedMergeCommit: 'returned-sha',
    })).toThrow(/does not match merge result/);
  });

  it('builds a discarded disposition with stable unique preserved branches', () => {
    expect(buildDiscardedPacketDisposition({
      disposition: 'superseded',
      reason: '  Replaced by a later packet. ',
      preservedBranches: ['preserved/one', 'preserved/one', ' preserved/two '],
      closedAt: '2026-08-29T19:05:00.000Z',
    })).toEqual({
      kind: 'discarded',
      disposition: 'superseded',
      reason: 'Replaced by a later packet.',
      preservedBranches: ['preserved/one', 'preserved/two'],
      closedAt: '2026-08-29T19:05:00.000Z',
    });
  });
});
