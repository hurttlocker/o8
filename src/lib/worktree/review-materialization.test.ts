import { describe, expect, it } from 'vitest';
import { assertReviewMaterializationOptions } from './review-materialization';
import type { CreateWorktreeOptions } from './types';
const valid: CreateWorktreeOptions = { agentType: 'review', taskName: 'review', managed: true, materializationOnly: true, isolationPreference: 'git-worktree', baseBranch: 'a'.repeat(40) };
describe('review materialization scope', () => {
  it('accepts an immutable managed review', () => expect(() => assertReviewMaterializationOptions(valid)).not.toThrow());
  it.each([{ agentType: 'codex' }, { managed: false }, { isolationPreference: 'auto' }, { baseBranch: 'main' }, { packetId: 'packet' }, { laneId: 'lane' }])('rejects incompatible options %o', (patch) => expect(() => assertReviewMaterializationOptions({ ...valid, ...patch } as CreateWorktreeOptions)).toThrow('Review materialization requires'));
});
