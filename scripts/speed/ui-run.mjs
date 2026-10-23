#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { root, writeJson } from './common.mjs';
import { fixture, startStack } from './stack.mjs';
import { openBrowser } from './ui.mjs';

const evidence = path.join(root, `tmp/speed-evidence/ui-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const bootOnly = process.argv.includes('--boot-only');
const output = path.join(root, `tmp/speed-evidence/${bootOnly ? 'boot' : 'ui'}.json`);
const receipt = { schema: 'o8/speed-ui/v1', runs: [], failures: [], method: 'Observer-ready handshake before trusted keydown' };
for (let sample = 1; sample <= 3; sample++) {
  const dir = path.join(evidence, `sample-${sample}`);
  fs.mkdirSync(dir);
  const seeded = fixture(dir);
  let stack, ui;
  try {
    stack = await startStack(seeded, dir);
    ui = await openBrowser(stack, seeded);
    const row = { sample, boot: ui.boot, nextHealthyMs: stack.nextHealthyMs, wsHealthyMs: stack.wsHealthyMs, observations: [] };
    receipt.runs.push(row);
    for (let repetition = 1; repetition <= (bootOnly ? 0 : 3); repetition++) for (const sessions of repetition % 2 ? [1, 4] : [4, 1]) {
      process.stderr.write(`[speed] UI ${sample}/3 repetition ${repetition}, streams=${sessions}\n`);
      row.observations.push({ repetition, ...await ui.measure(sessions) });
      writeJson(output, receipt);
    }
    if (bootOnly) {
      if (!row.boot.paints.length) throw new Error('Browser did not report a paint entry');
      writeJson(output, receipt);
      continue;
    }
    await ui.page.evaluate(() => {
      window.__speedDelay = () => { const start = performance.now(); while (performance.now() - start < 150) { /* calibration */ } };
      document.querySelector('textarea[data-o8-active-composer="true"]').addEventListener('keydown', window.__speedDelay, true);
    });
    row.calibrationMs = await ui.key();
    if (row.calibrationMs < 150 || row.calibrationMs >= 5000) throw new Error('Input calibration failed');
  } catch (error) { receipt.failures.push({ sample, error: error.message }); }
  finally { await ui?.close(); await stack?.close(); }
  writeJson(output, receipt);
}
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (receipt.failures.length) process.exitCode = 1;
