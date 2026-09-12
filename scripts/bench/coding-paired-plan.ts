import fs from 'node:fs';
import path from 'node:path';

import type { CodingTask } from './coding';

const DEFAULT_SEED = 20_260_802;

export interface CodingEndToEndNotCollectedReceipt {
  schema: 'o8/coding-end-to-end-not-collected/v1';
  runId: string;
  status: 'not-collected';
  reason: 'paired-only phase selected';
}

export function createNotCollectedEndToEnd(
  runId: string,
): CodingEndToEndNotCollectedReceipt {
  return {
    schema: 'o8/coding-end-to-end-not-collected/v1',
    runId,
    status: 'not-collected',
    reason: 'paired-only phase selected',
  };
}

export function readCodingTasks(repoRoot: string): CodingTask[] {
  const tasksFile = path.join(repoRoot, 'tests/bench/coding/tasks.json');
  const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf8')) as { tasks?: CodingTask[] };
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('tests/bench/coding/tasks.json has no tasks');
  }
  for (const task of parsed.tasks) {
    if (!Number.isInteger(task.issue) || task.issue <= 0 || !task.base?.trim() || !task.label?.trim()) {
      throw new Error(`invalid coding task fixture: ${JSON.stringify(task)}`);
    }
  }
  return parsed.tasks;
}

export function codingCollectionSeed(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.O8_BENCH_SEED ?? DEFAULT_SEED);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error('O8_BENCH_SEED must be an unsigned 32-bit integer');
  }
  return parsed;
}

export function seededCodingShuffle(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  return <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(next() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  };
}
