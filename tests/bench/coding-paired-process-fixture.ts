import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODING_PAIRED_SOURCE_ROOT = process.cwd();
const RUNNER = path.join(CODING_PAIRED_SOURCE_ROOT, 'scripts/bench/run-coding.ts');
const TSX_LOADER = path.join(CODING_PAIRED_SOURCE_ROOT, 'node_modules/tsx/dist/loader.mjs');
const SERVER_ONLY_STUB = path.join(CODING_PAIRED_SOURCE_ROOT, 'scripts/register-server-only-stub.mjs');
export const codingPairedRuntimeConfig = {
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

export type CodingPairedFixtureMode =
  | 'valid'
  | 'worker-failed'
  | 'no-diff'
  | 'empty-diff'
  | 'missing-contract'
  | 'typecheck-failed'
  | 'eslint-failed';

function executable(filePath: string, source: string): void {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

function fakeCommands(binDir: string): void {
  const logger = `
const fs = require('node:fs');
const log = (command, args) => fs.appendFileSync(
  process.env.O8_BENCH_FAKE_COMMAND_LOG,
  JSON.stringify({ command, args }) + '\\n',
);`;

  executable(path.join(binDir, 'git'), `#!/usr/bin/env node
${logger}
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.O8_BENCH_FIXTURE_MODE || 'valid';
log('git', args);
if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') console.log(process.env.O8_BENCH_FAKE_REPO);
else if (args[0] === 'rev-parse') console.log('1530f7099fake');
else if (args[0] === 'branch' && args[1] === '--show-current') console.log('main');
else if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(args.at(-2), { recursive: true });
else if (args[0] === 'diff' && args.includes('--name-only')) {
  if (mode !== 'no-diff') console.log('candidate.ts');
} else if (args[0] === 'diff' && args.includes('--numstat')) {
  if (mode !== 'no-diff') console.log('1\\t0\\tcandidate.ts');
} else if (args[0] === 'diff' && mode !== 'no-diff' && mode !== 'empty-diff') console.log([
  'diff --git a/candidate.ts b/candidate.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/candidate.ts',
  '@@ -0,0 +1 @@',
  '+export const candidate = true;',
].join('\\n'));
`);

  executable(path.join(binDir, 'gh'), `#!/usr/bin/env node
${logger}
const args = process.argv.slice(2);
log('gh', args);
if (args[0] === 'api') {
  const issue = Number(args[1].split('/').at(-1));
  console.log(JSON.stringify({ number: issue, state: 'open', title: 'Fixture issue ' + issue, body: 'Fixture body.' }));
}
`);

  executable(path.join(binDir, 'ginsu'), `#!/usr/bin/env node
${logger}
const path = require('node:path');
const args = process.argv.slice(2);
log('ginsu', args);
const statePath = process.env.O8_BENCH_FAKE_GINSU_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
if (args[0] === 'spawn') {
  state[args[1]] = args[2];
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === 'send') {
  const prompt = args[2] || '';
  const output = prompt.match(/Write the JSON array to: (.+)/)?.[1]?.trim();
  if (output) {
    const labels = [...prompt.matchAll(/^- ([A-Z]): /gm)].map((match) => match[1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(labels.map((blindLabel) => ({
      blindLabel,
      subScores: { correctness: 5, scopeDiscipline: 5, robustness: 5, fit: 5 },
      mostSeriousDefect: 'fixture',
    }))));
  } else {
    if (process.env.O8_BENCH_FIXTURE_MODE === 'worker-failed') {
      console.log('turn failed (exit 1)');
      process.exit(1);
    }
    const worktree = state[args[1]];
    fs.writeFileSync(path.join(worktree, 'candidate.ts'), 'export const candidate = true;\\n');
    if (prompt.includes('Contract-first intervention:')
      && process.env.O8_BENCH_FIXTURE_MODE !== 'missing-contract') {
      fs.writeFileSync(path.join(worktree, 'task-contract.json'), JSON.stringify({
        version: 1,
        requirements: [{
          id: 'R1',
          source: 'fixture',
          expectedBehavior: 'fixture',
          productionPath: 'candidate.ts',
          verification: 'fixture',
        }],
        smallestRoute: [{ path: 'candidate.ts', requirements: ['R1'], reason: 'fixture' }],
        exclusions: [],
      }));
    }
  }
  console.log('fixture turn completed');
}
`);

  executable(path.join(binDir, 'npx'), `#!/bin/sh
printf '%s\\n' \"{\\\"command\\\":\\\"npx\\\",\\\"args\\\":[\\\"$*\\\"]}\" >> \"$O8_BENCH_FAKE_COMMAND_LOG\"
if [ \"$O8_BENCH_FIXTURE_MODE\" = 'typecheck-failed' ] && [ \"$1\" = 'tsc' ]; then exit 1; fi
if [ \"$O8_BENCH_FIXTURE_MODE\" = 'eslint-failed' ] && [ \"$1\" = 'eslint' ]; then exit 1; fi
exit 0
`);
  executable(path.join(binDir, 'cp'), `#!/bin/sh
printf '%s\\n' \"{\\\"command\\\":\\\"cp\\\",\\\"args\\\":[\\\"$*\\\"]}\" >> \"$O8_BENCH_FAKE_COMMAND_LOG\"
/bin/cp -R \"$3\" \"$4\"
`);
  executable(path.join(binDir, 'o8'), `#!/bin/sh
printf '%s\\n' \"{\\\"command\\\":\\\"o8\\\",\\\"args\\\":[\\\"$*\\\"]}\" >> \"$O8_BENCH_FAKE_COMMAND_LOG\"
printf '%s\\n' 'mission create --existingBranchPolicy'
`);
}

export function createCodingPairedFixture(mode: CodingPairedFixtureMode = 'valid'): {
  root: string;
  dataDir: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
} {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-coding-paired-cli-')));
  const binDir = path.join(root, 'bin');
  const dataDir = path.join(root, 'no-live-app');
  const tempDir = path.join(root, 'tmp');
  const configPath = path.join(root, 'runtime-config.json');
  mkdirSync(path.join(root, 'tests/bench/coding'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/better-sqlite3'), { recursive: true });
  mkdirSync(binDir);
  mkdirSync(dataDir);
  mkdirSync(tempDir);
  copyFileSync(
    path.join(CODING_PAIRED_SOURCE_ROOT, 'tests/bench/coding/tasks.json'),
    path.join(root, 'tests/bench/coding/tasks.json'),
  );
  copyFileSync(
    path.join(CODING_PAIRED_SOURCE_ROOT, 'tests/bench/coding/end-to-end-tasks.json'),
    path.join(root, 'tests/bench/coding/end-to-end-tasks.json'),
  );
  writeFileSync(
    path.join(root, 'node_modules/better-sqlite3/package.json'),
    JSON.stringify({ main: 'index.js' }),
  );
  writeFileSync(
    path.join(root, 'node_modules/better-sqlite3/index.js'),
    'module.exports = () => ({ close() {} });\n',
  );
  writeFileSync(configPath, `${JSON.stringify(codingPairedRuntimeConfig)}\n`);
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: CODING_PAIRED_SOURCE_ROOT,
      paths: { '@/*': ['src/*'] },
    },
  }));
  fakeCommands(binDir);
  const logPath = path.join(root, 'commands.jsonl');
  return {
    root,
    dataDir,
    logPath,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      TMPDIR: tempDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_BENCH_REPO: 'fixture/o8',
      O8_BENCH_RUN_ID: 'paired-only-2252',
      O8_BENCH_RUNTIME_CONFIG: configPath,
      O8_BENCH_FAKE_COMMAND_LOG: logPath,
      O8_BENCH_FAKE_GINSU_STATE: path.join(root, 'ginsu-state.json'),
      O8_BENCH_FAKE_REPO: root,
      O8_BENCH_FIXTURE_MODE: mode,
    },
  };
}

export function runCodingPairedCli(root: string, env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [
    '--import', SERVER_ONLY_STUB,
    '--import', TSX_LOADER,
    RUNNER,
    ...args,
  ], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
}

export function codingPairedCommands(logPath: string): Array<{ command: string; args: string[] }> {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => (
    JSON.parse(line) as { command: string; args: string[] }
  ));
}
