import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const directory = process.env.O8_TRANSCRIPT_REUSE_PROOF_DIR ?? process.env.CORTEX_IDE_DATA_DIR!;
async function measure(engine: string, control = false) {
  await mkdir(directory, { recursive: true });
  const name = `${engine}${control ? '-control' : ''}`;
  const receipt = join(directory, `${name}.json`);
  let failed = false;
  try {
    await promisify(execFile)(process.execPath, ['scripts/bench/interactions/transcript-tab-reuse.mjs',
      `--engine=${engine}`, '--expect-reuse', `--output=${receipt}`, `--screenshot=${join(directory, `${name}.png`)}`,
      ...(control ? ['--force-row-invalidation'] : []),
    ], { timeout: 90000 });
  } catch { failed = true; }
  return { failed, receipt: JSON.parse(await readFile(receipt, 'utf8')) };
}
it.each(['chromium', 'webkit'])('reuses historical turns while retaining scroll and live output in %s', async engine => {
  const { failed, receipt } = await measure(engine);
  expect(receipt.errors).toEqual([]);
  expect(receipt.observations.map((value: { closedRowRenders: number }) => value.closedRowRenders)).toEqual([0, 0, 0]);
  expect(receipt).toMatchObject({ passed: true, retained: true, draftRetained: true, selectionRetained: true });
  expect(failed).toBe(false);
}, 120000);
it('rejects a deliberate restoration of historical row invalidation', async () => {
  const { failed, receipt } = await measure('chromium', true);
  expect(failed).toBe(true);
  expect(receipt.passed).toBe(false);
  expect(receipt.observations.every((value: { closedRowRenders: number }) => value.closedRowRenders > 0)).toBe(true);
}, 120000);
