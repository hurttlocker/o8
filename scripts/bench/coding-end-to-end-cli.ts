import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { judgeEndToEnd } from './judge-coding-end-to-end';
import {
  collectEndToEnd,
  createEndToEndCollection,
  preflightEndToEnd,
  readEndToEndTasks,
  type EndToEndCollectionReceipt,
} from './run-coding-end-to-end';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertTool(command: string, repoRoot: string): void {
  const result = spawnSync(command, ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${command} is unavailable`);
}

function standaloneCollectionPath(workRoot: string): string {
  return path.join(workRoot, 'end-to-end-collection.json');
}

export function assertUnusedCodingRunId(workRoot: string, runId: string): void {
  const existing = [
    path.join(workRoot, 'collection.json'),
    standaloneCollectionPath(workRoot),
  ].find((candidate) => fs.existsSync(candidate));
  if (existing) {
    throw new Error(
      `benchmark run ${runId} already has a collection receipt at ${existing}; use a new immutable run ID`,
    );
  }
}

export function preflightStandaloneEndToEnd(input: {
  repoRoot: string;
  workRoot: string;
  runId: string;
}): void {
  assertUnusedCodingRunId(input.workRoot, input.runId);
  const root = path.resolve(input.repoRoot);
  const actualRoot = path.resolve(
    spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  );
  if (root !== actualRoot) throw new Error(`run the coding benchmark from the repository root: ${actualRoot}`);
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    throw new Error('node_modules is missing; run npm install before the benchmark');
  }
  for (const command of ['ginsu', 'gh', 'o8']) assertTool(command, root);
  const tasks = readEndToEndTasks(root);
  const result = preflightEndToEnd(root, tasks);
  if (result.approvalMode !== 'always') {
    throw new Error(
      `standalone end-to-end collection requires requireApproval=always; current=${result.approvalMode}`,
    );
  }
  console.log(
    `[coding:e2e] preflight OK: run=${input.runId}, issues=1676,1678,1679, ` +
    `arms=3/task, base=${result.baseCommit}, approval=${result.approvalMode}, collection=not started`,
  );
}

export async function collectStandaloneEndToEnd(input: {
  repoRoot: string;
  workRoot: string;
  runId: string;
}): Promise<EndToEndCollectionReceipt> {
  preflightStandaloneEndToEnd(input);
  const tasks = readEndToEndTasks(input.repoRoot);
  const collection = createEndToEndCollection(input.repoRoot, input.runId, tasks);
  const collectionPath = standaloneCollectionPath(input.workRoot);
  writeJson(collectionPath, collection);
  return collectEndToEnd({
    repoRoot: input.repoRoot,
    workRoot: input.workRoot,
    collection,
    onUpdate: (receipt) => writeJson(collectionPath, receipt),
  });
}

export function judgeStandaloneEndToEnd(input: {
  repoRoot: string;
  workRoot: string;
  runId: string;
  seed: number;
  latestDir: string;
}): void {
  const collectionPath = standaloneCollectionPath(input.workRoot);
  if (!fs.existsSync(collectionPath)) {
    throw new Error(`benchmark run ${input.runId} has no standalone end-to-end collection receipt`);
  }
  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8')) as EndToEndCollectionReceipt;
  if (collection.schema !== 'o8/coding-end-to-end-collection/v1' || collection.runId !== input.runId) {
    throw new Error('standalone end-to-end collection is missing or uses an unsupported schema');
  }
  const result = judgeEndToEnd({
    repoRoot: input.repoRoot,
    workRoot: input.workRoot,
    seed: input.seed,
    collection,
  });
  const output = {
    schema: 'o8/coding-end-to-end-benchmark/v1',
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    collection,
    result,
  };
  writeJson(path.join(input.workRoot, 'end-to-end-result.json'), output);
  writeJson(path.join(input.latestDir, 'coding-end-to-end.json'), output);
}
