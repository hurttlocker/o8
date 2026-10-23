import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const laneId = process.env.O8_TEST_MERGE_LANE_ID;
const resultPath = process.env.O8_TEST_MERGE_RESULT_PATH;

describe.skipIf(!laneId || !resultPath)('publication crash child', () => {
  it('runs publication through the real lane command entry point', async () => {
    const { dispatch } = await import('@/lib/lane/commands');
    const result = await dispatch({ verb: 'create_pr', laneId: laneId!, actor: 'user' });
    writeFileSync(resultPath!, JSON.stringify(result));
    expect(result).toMatchObject({ ok: true });
  }, 60_000);
});
