import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

const runtimeConfig = {
  schema: 'o8/coding-runtime-config/v1',
  arms: {
    codex: { model: 'test/codex-arm', effort: 'high' },
    claude: { model: 'test/claude-arm', effort: 'max' },
  },
  judges: {
    codex: { model: 'test/codex-judge', effort: 'medium' },
    claude: { model: 'test/claude-judge', effort: 'high' },
  },
};

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

function installFakeCommands(root: string): { binDir: string; launcherLog: string; o8Cli: string } {
  const binDir = path.join(root, 'bin');
  const launcherLog = path.join(root, 'launcher.jsonl');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') process.stdout.write(process.cwd() + '\\n');
else if (args[0] === 'rev-parse') process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
else if (args[0] === 'branch') process.stdout.write('main\\n');
else if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(args[4], { recursive: true });
else if (args[0] === 'worktree' && args[1] === 'remove') fs.rmSync(args[3], { recursive: true, force: true });
else if (args[0] === 'diff' && args.includes('--name-only')) process.stdout.write('src/example.ts\\n');
else if (args[0] === 'diff' && args.includes('--numstat')) process.stdout.write('1\\t0\\tsrc/example.ts\\n');
else if (args[0] === 'diff' && args.includes('--binary')) process.stdout.write('diff --git a/src/example.ts b/src/example.ts\\n');
`);
  writeExecutable(path.join(binDir, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write('example/repo\\n');
else if (args[0] === 'api') {
  const issue = Number(args[1].split('/').at(-1));
  process.stdout.write(JSON.stringify({ number: issue, state: 'open', title: 'Fixture issue', body: 'Fixture body' }));
}
`);
  writeExecutable(path.join(binDir, 'ginsu'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LAUNCHER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'send') process.stdout.write('fixture worker reply\\n');
`);
  writeExecutable(path.join(binDir, 'npx'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(binDir, 'cp'), `#!/usr/bin/env node
const fs = require('node:fs');
const destination = process.argv.at(-1);
fs.mkdirSync(destination, { recursive: true });
`);
  const o8Cli = path.join(binDir, 'o8-fixture');
  writeExecutable(o8Cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) process.stdout.write('--existingBranchPolicy\\n');
else process.exit(1);
`);
  return { binDir, launcherLog, o8Cli };
}

async function startFakeBackend(root: string): Promise<{ port: number; stop: () => void }> {
  const serverPath = path.join(root, 'backend.cjs');
  fs.writeFileSync(serverPath, `
const http = require('node:http');
let requireApproval = 'always';
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/panel/status') response.end(JSON.stringify({ product: 'o8' }));
  else if (request.url === '/api/panel/operator-defaults' && request.method === 'GET') {
    response.end(JSON.stringify({ values: { requireApproval } }));
  } else if (request.url === '/api/panel/operator-defaults' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requireApproval = JSON.parse(body).requireApproval;
      response.end(JSON.stringify({ values: { requireApproval } }));
    });
  } else { response.statusCode = 404; response.end('{}'); }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`);
  const child = spawn(process.execPath, [serverPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (data) => resolve(Number(String(data).trim())));
  });
  return { port, stop: () => child.kill('SIGTERM') };
}

function runBenchmark(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxCli, 'scripts/bench/run-coding.ts', ...args], {
    cwd: repoRoot,
    env: {
      ...env,
      NODE_OPTIONS: `--import=${path.join(repoRoot, 'scripts/register-server-only-stub.mjs')}`,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('coding benchmark runtime configuration through the process entry point', () => {
  it('rejects missing and malformed configuration before inspecting the launcher', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-runtime-missing-'));
    const { binDir, launcherLog, o8Cli } = installFakeCommands(root);
    try {
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_LAUNCHER_LOG: launcherLog,
        O8_BENCH_O8_CLI: o8Cli,
        O8_BENCH_REPO: 'example/repo',
        CORTEX_IDE_DATA_DIR: path.join(root, 'data'),
      };
      const missing = runBenchmark(['--preflight'], env);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('O8_BENCH_RUNTIME_CONFIG');

      const malformedPath = path.join(root, 'malformed.json');
      fs.writeFileSync(malformedPath, '{"schema":');
      const malformed = runBenchmark(['--preflight'], {
        ...env,
        O8_BENCH_RUNTIME_CONFIG: malformedPath,
      });
      expect(malformed.status).not.toBe(0);
      expect(malformed.stderr).toContain('invalid coding runtime config');
      expect(fs.existsSync(launcherLog)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes pinned arm settings through collection and persists requested-setting receipts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-runtime-real-path-'));
    const runId = `runtime-config-${process.pid}-${Date.now()}`;
    const runRoot = path.join(os.tmpdir(), 'o8-bench-coding', runId);
    const configPath = path.join(root, 'runtime-config.json');
    const dataDir = path.join(root, 'data');
    const { binDir, launcherLog, o8Cli } = installFakeCommands(root);
    const backend = await startFakeBackend(root);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig)}\n`);
    fs.writeFileSync(path.join(dataDir, 'api-port'), `${backend.port}\n`);
    fs.writeFileSync(path.join(dataDir, 'ws-token'), 'fixture-token\n');
    fs.writeFileSync(path.join(dataDir, 'operator-defaults.json'), '{"requireApproval":"always"}\n');
    try {
      const result = runBenchmark(['--collect'], {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_LAUNCHER_LOG: launcherLog,
        O8_BENCH_RUNTIME_CONFIG: configPath,
        O8_BENCH_RUN_ID: runId,
        O8_BENCH_O8_CLI: o8Cli,
        O8_BENCH_REPO: 'example/repo',
        O8_BENCH_LATEST_DIR: path.join(root, 'latest'),
        CORTEX_IDE_DATA_DIR: dataDir,
      });
      expect(result.status, result.stderr).toBe(0);

      const collection = JSON.parse(fs.readFileSync(path.join(runRoot, 'collection.json'), 'utf8')) as {
        requestedSettings?: typeof runtimeConfig;
        arms: Array<{
          runtime: 'codex' | 'claude';
          worker: string;
          requestedSettings?: { model: string; effort: string };
          dependencies: { destination: string; owned: boolean; symbolicLink: boolean };
          spawn: { command: string };
        }>;
      };
      expect(collection.requestedSettings).toEqual(runtimeConfig);
      expect(collection.arms).toHaveLength(12);
      for (const arm of collection.arms) {
        expect(arm.requestedSettings).toEqual(runtimeConfig.arms[arm.runtime]);
        expect(arm.spawn.command).toContain(`--model ${runtimeConfig.arms[arm.runtime].model}`);
        expect(arm.spawn.command).toContain(`--effort ${runtimeConfig.arms[arm.runtime].effort}`);
        expect(arm.dependencies).toMatchObject({ owned: true, symbolicLink: false });
        expect(fs.lstatSync(arm.dependencies.destination).isSymbolicLink()).toBe(false);
      }
      const armWorkers = new Set(collection.arms.map((arm) => arm.worker));
      const launches = fs.readFileSync(launcherLog, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === 'spawn' && armWorkers.has(args[1]));
      expect(launches).toHaveLength(12);
      for (const args of launches) {
        const runtime = args[args.indexOf('--engine') + 1] as 'codex' | 'claude';
        expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
          .toEqual(['--model', runtimeConfig.arms[runtime].model]);
        expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2))
          .toEqual(['--effort', runtimeConfig.arms[runtime].effort]);
      }

      const judgeResult = runBenchmark(['--judge'], {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_LAUNCHER_LOG: launcherLog,
        O8_BENCH_RUNTIME_CONFIG: configPath,
        O8_BENCH_RUN_ID: runId,
        O8_BENCH_REPO: 'example/repo',
        O8_BENCH_LATEST_DIR: path.join(root, 'latest'),
        CORTEX_IDE_DATA_DIR: dataDir,
      });
      expect(judgeResult.status, judgeResult.stderr).toBe(0);
      const judging = JSON.parse(fs.readFileSync(path.join(runRoot, 'judging.json'), 'utf8')) as {
        requestedSettings?: typeof runtimeConfig.judges;
        receipts: Array<{
          judge: 'codex' | 'claude';
          worker: string;
          requestedSettings?: { model: string; effort: string };
          dependencies: { destination: string; owned: boolean; symbolicLink: boolean };
          spawn: { command: string };
        }>;
      };
      expect(judging.requestedSettings).toEqual(runtimeConfig.judges);
      expect(judging.receipts).toHaveLength(6);
      for (const receipt of judging.receipts) {
        expect(receipt.requestedSettings).toEqual(runtimeConfig.judges[receipt.judge]);
        const spawnArgv = receipt.spawn.command.split(' ');
        expect(spawnArgv.slice(spawnArgv.indexOf('--model'), spawnArgv.indexOf('--model') + 2))
          .toEqual(['--model', receipt.requestedSettings?.model]);
        expect(spawnArgv.slice(spawnArgv.indexOf('--effort'), spawnArgv.indexOf('--effort') + 2))
          .toEqual(['--effort', receipt.requestedSettings?.effort]);
        expect(receipt.dependencies).toMatchObject({ owned: true, symbolicLink: false });
        expect(fs.lstatSync(receipt.dependencies.destination).isSymbolicLink()).toBe(false);
      }
      const judgeWorkers = new Set(judging.receipts.map((receipt) => receipt.worker));
      const judgeLaunches = fs.readFileSync(launcherLog, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === 'spawn' && judgeWorkers.has(args[1]));
      expect(judgeLaunches).toHaveLength(6);
      for (const args of judgeLaunches) {
        const judge = args[args.indexOf('--engine') + 1] as 'codex' | 'claude';
        expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
          .toEqual(['--model', runtimeConfig.judges[judge].model]);
        expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2))
          .toEqual(['--effort', runtimeConfig.judges[judge].effort]);
      }
    } finally {
      backend.stop();
      fs.rmSync(runRoot, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
