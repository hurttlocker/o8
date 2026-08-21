import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const laneId = process.env.O8_TEST_MERGE_LANE_ID;
const resultPath = process.env.O8_TEST_MERGE_RESULT_PATH;

describe.skipIf(!laneId || !resultPath)('worktree-side merge child', () => {
  it('runs the actual merge entry point in a separate process', async () => {
    const { getLane } = await import('@/lib/lane/registry');
    const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
    const lane = getLane(laneId!);
    expect(lane).not.toBeNull();
    const result = await performWorktreeSideMerge({
      lane: lane!,
      command: {
        verb: 'merge',
        laneId: laneId!,
        actor: 'system',
        orchestratorReviewed: true,
      },
      actor: 'system',
      gateResult: { passed: true, violations: [] },
      createLaneActionApproval: async (_lane, _actor, input) => ({
        ok: false,
        laneId: laneId!,
        note: input.note,
      }),
    });
    writeFileSync(resultPath!, JSON.stringify(result));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  }, 30_000);
});
