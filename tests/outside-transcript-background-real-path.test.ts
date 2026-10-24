import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { webkit } from 'playwright-core';
import { expect, it } from 'vitest';

const directory = process.env.O8_OUTSIDE_TRANSCRIPT_PROOF_DIR ?? process.env.CORTEX_IDE_DATA_DIR!;
async function measure(engine: string, control = false, surface = 'outside', hiddenDocument = false) {
  await mkdir(directory, { recursive: true });
  const name = `${surface}-${engine}${hiddenDocument ? '-document-hidden' : ''}${control ? '-control' : ''}`;
  const receipt = join(directory, `${name}.json`);
  await rm(receipt, { force: true });
  let failed = false; let stderr = '';
  try {
    const result = await promisify(execFile)(process.execPath, ['scripts/bench/interactions/outside-transcript-background.mjs',
      `--engine=${engine}`, `--surface=${surface}`, `--output=${receipt}`, `--screenshot=${join(directory, `${name}.png`)}`,
      ...(hiddenDocument ? ['--hidden-document'] : []),
      ...(control ? ['--force-foreground'] : []),
    ], { timeout: 90000 });
    stderr = result.stderr;
  } catch (error) { failed = true; stderr = String((error as { stderr?: string }).stderr ?? error); }
  try { return { failed, receipt: JSON.parse(await readFile(receipt, 'utf8')) }; }
  catch (error) { throw new Error(`${name} benchmark receipt missing or unreadable.\n${stderr}`, { cause: error }); }
}
for (const engine of ['chromium', 'webkit']) it.runIf(engine !== 'webkit' || existsSync(webkit.executablePath()))(
  `bounds selected transcripts in a hidden document and catches up in ${engine}`, async () => {
    const { failed, receipt } = await measure(engine, false, 'outside', true);
    expect(receipt.errors).toEqual([]);
    expect(receipt.error).toBeUndefined();
    expect(receipt.observations).toHaveLength(3);
    expect(receipt).toMatchObject({ passed: true, documentWasHidden: true, windowCatchUp: true, transcriptHealthy: true,
      catchUp: true, retained: true, scrollPreserved: true, selectionPreserved: true });
    expect(failed).toBe(false);
  }, 120000);
it('rejects foreground visibility in the hidden-document workload', async () => {
  const { failed, receipt } = await measure('chromium', true, 'outside', true);
  expect(receipt.errors).toEqual([]);
  expect(receipt.error).toBeUndefined();
  expect(receipt.observations).toHaveLength(3);
  expect(receipt.transcriptHealthy).toBe(true);
  expect(receipt.documentWasHidden).toBe(false);
  expect(receipt.observations.every((row: { visibleBatches: number }) => row.visibleBatches > 4)).toBe(true);
  expect(receipt.passed).toBe(false);
  expect(failed).toBe(true);
}, 120000);
for (const surface of ['outside', 'workspace']) {
  for (const engine of ['chromium', 'webkit']) it.runIf(engine !== 'webkit' || existsSync(webkit.executablePath()))(
    `bounds hidden ${surface} transcripts and preserves scroll in ${engine}`, async () => {
      const { failed, receipt } = await measure(engine, false, surface);
      expect(receipt.errors).toEqual([]);
      expect(receipt.error).toBeUndefined();
      expect(receipt.observations).toHaveLength(3);
      expect(receipt).toMatchObject({ passed: true, transcriptHealthy: true, catchUp: true, retained: true, scrollPreserved: true, selectionPreserved: true, draftRetained: true, draftSelectionRetained: true });
      expect(failed).toBe(false);
    }, 120000);
  it(`rejects foreground cadence in hidden ${surface} panes`, async () => {
    const { failed, receipt } = await measure('chromium', true, surface);
    expect(receipt.error).toBeUndefined();
    expect(receipt.errors).toEqual([]);
    expect(receipt.observations).toHaveLength(3);
    expect(receipt.transcriptHealthy).toBe(true);
    expect(receipt.observations.every((row: { hiddenBatches: number[] }) => row.hiddenBatches.every(count => count > 4))).toBe(true);
    expect(receipt.passed).toBe(false);
    expect(failed).toBe(true);
  }, 120000);
}
