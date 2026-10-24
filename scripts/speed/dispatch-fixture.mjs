#!/usr/bin/env node
// The existing scheduler fixture and persisted-stage observer, without accounts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { distribution, evidencePath, root, writeJson } from './common.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = evidencePath(option('output') ?? 'work/launch-fixture');
const payload = option('payload');
const warm = !process.argv.includes('--cold');
const npmCli = process.env.npm_execpath ?? (process.env.PATH ?? '').split(path.delimiter)
  .map(directory => path.join(directory, 'npm')).filter(file => fs.existsSync(file))
  .map(file => fs.realpathSync(file)).find(file => path.basename(file) === 'npm-cli.js');
if (!npmCli) throw new Error('Run through npm or put the npm CLI symlink on PATH.');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const receipt = { schema: 'o8/speed-dispatch-fixture/v1', platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]), payload: payload ? 'installed-dependency-copy' : 'small-fixture', warm, samples: [], failures: [],
  limits: 'Real scheduler, provisioning, owned runtime and stdout; fixture installer and runtime use no network or accounts. Optional payload is copied privately. No macOS, provider latency or physical-block claim.' };
for (let sample = 1; sample <= 3; sample++) {
  const file = path.join(output, `sample-${sample}.json`);
  const log = path.join(output, `sample-${sample}.log`);
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(log, 'w', 0o600);
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/packet-launch-budget-real-path.test.ts'], {
    cwd: root, stdio: ['ignore', fd, fd], timeout: 600_000,
    env: { ...process.env, npm_execpath: npmCli, O8_SPEED_RECEIPT: file, O8_SPEED_WARM: warm ? '1' : '0',
      ...(payload ? { O8_SPEED_DEPENDENCY_PAYLOAD: path.resolve(payload) } : {}) },
  });
  fs.closeSync(fd);
  if (fs.existsSync(file)) {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    row.stages.otherWorkspaceMs = row.stages.workspaceProvisioningMs - row.stages.dependencyProvisioningMs;
    receipt.samples.push({ sample, ...row });
  }
  if (result.status !== 0) receipt.failures.push({ sample, exitCode: result.status, error: result.error?.code ?? null });
  writeJson(path.join(output, 'receipt.json'), receipt);
}
receipt.summary = Object.fromEntries(['dispatchToOutputMs', 'sessionMs', 'spawnToOutputMs'].map(key => [key, distribution(receipt.samples.map(row => row[key]))]));
receipt.phases = Object.fromEntries(['admissionMs', 'workspaceProvisioningMs', 'otherWorkspaceMs', 'dependencyProvisioningMs', 'runtimeSpawnMs'].map(key => [key, distribution(receipt.samples.map(row => row.stages[key]))]));
writeJson(path.join(output, 'receipt.json'), receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (receipt.failures.length || receipt.samples.length !== 3) process.exitCode = 1;
