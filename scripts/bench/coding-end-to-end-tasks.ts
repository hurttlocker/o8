import fs from 'node:fs';
import path from 'node:path';

import type { EndToEndTask } from './coding-end-to-end';

const EXPECTED_END_TO_END_ISSUES = [1676, 1678, 1679];

export function assertExactEndToEndTasks(tasks: EndToEndTask[]): void {
  const actual = tasks.map((task) => task.issue);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_END_TO_END_ISSUES)) {
    throw new Error(
      `end-to-end tasks must be exactly ${EXPECTED_END_TO_END_ISSUES.join(', ')} in that order`,
    );
  }
}

export function readEndToEndTasks(repoRoot: string): EndToEndTask[] {
  const filePath = path.join(repoRoot, 'tests/bench/coding/end-to-end-tasks.json');
  let parsed: { schema?: unknown; tasks?: EndToEndTask[] };
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof parsed;
  } catch {
    throw new Error(`${filePath} returned malformed JSON`);
  }
  if (parsed.schema !== 'o8/coding-end-to-end-tasks/v1' || !Array.isArray(parsed.tasks)) {
    throw new Error('end-to-end task fixture is missing or uses an unsupported schema');
  }
  assertExactEndToEndTasks(parsed.tasks);
  for (const task of parsed.tasks) {
    if (!Number.isInteger(task.issue) || !task.label?.trim()) {
      throw new Error(`invalid end-to-end task fixture: ${JSON.stringify(task)}`);
    }
  }
  return parsed.tasks;
}
