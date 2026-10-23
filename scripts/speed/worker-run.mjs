#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { root, evidencePath, writeJson, distribution } from './common.mjs';
import { fixture, startStack } from './stack.mjs';
import { measureWorker, prepareWorkerFixture } from './workers.mjs';

const runtime = process.argv.find(arg => arg.startsWith('--runtime='))?.slice(10) ?? 'codex';
if (!['codex', 'claude-code'].includes(runtime)) throw new Error('Select codex or claude-code');
const evidence = path.join(root, `tmp/speed-evidence/workers-${runtime}-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const seeded = fixture(evidence);
prepareWorkerFixture(seeded);
let stack;
const receipt = { schema: 'o8/speed-workers/v1', runtime, samples: [], failures: [] };
const output = evidencePath(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? path.join(root, `tmp/speed-evidence/workers-${runtime}.json`));
try {
  stack = await startStack(seeded, evidence);
  for (let sample = 1; sample <= 3; sample++) {
    process.stderr.write(`[speed] ${runtime} ${sample}/3\n`);
    receipt.samples.push(await measureWorker(stack, seeded, evidence, runtime, sample));
    writeJson(output, receipt);
  }
  const measured = receipt.samples.filter(row => row.status === 'measured');
  receipt.summary = {
    dispatchToAssistantOutputMs: distribution(measured.map(row => row.dispatchToAssistantOutputMs)),
    admissionMs: distribution(measured.map(row => row.stages.admissionMs)),
    workspaceProvisioningMs: distribution(measured.map(row => row.stages.workspaceProvisioningMs)),
    runtimeSpawnMs: distribution(measured.map(row => row.stages.runtimeSpawnMs)),
    spawnToAssistantOutputMs: distribution(measured.map(row => row.spawnToAssistantOutputMs)),
  };
} catch (error) { receipt.failures.push(error.message); }
finally { if (stack) await stack.close(); }
writeJson(output, receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (receipt.failures.length || receipt.samples.length !== 3) process.exitCode = 1;
