import fs from 'node:fs';
import path from 'node:path';

import type { EndToEndTask } from './coding-end-to-end';

export const ALL_END_TO_END_ISSUES = [1676, 1678, 1679] as const;

export interface EndToEndTaskSelectionReceipt {
  source: 'all' | 'subset';
  selectedIssues: number[];
  availableIssues: number[];
  isFullRun: boolean;
}

export function assertExactEndToEndTasks(tasks: EndToEndTask[]): void {
  const actual = tasks.map((task) => task.issue);
  if (JSON.stringify(actual) !== JSON.stringify(ALL_END_TO_END_ISSUES)) {
    throw new Error(
      `end-to-end tasks must be exactly ${ALL_END_TO_END_ISSUES.join(', ')} in that order`,
    );
  }
}

export function assertEndToEndTaskSelection(tasks: EndToEndTask[]): void {
  const issues = tasks.map((task) => task.issue);
  if (issues.length === 0) throw new Error('end-to-end task selection must contain at least one issue');
  if (new Set(issues).size !== issues.length) {
    throw new Error('end-to-end task selection must not contain duplicate issues');
  }
  const unknown = issues.filter((issue) => !ALL_END_TO_END_ISSUES.includes(
    issue as (typeof ALL_END_TO_END_ISSUES)[number],
  ));
  if (unknown.length > 0) {
    throw new Error(
      `end-to-end task selection contains unsupported issues: ${unknown.join(', ')}; ` +
      `available issues are ${ALL_END_TO_END_ISSUES.join(', ')}`,
    );
  }
}

export function endToEndTaskSelection(tasks: EndToEndTask[]): EndToEndTaskSelectionReceipt {
  assertEndToEndTaskSelection(tasks);
  const selectedIssues = tasks.map((task) => task.issue);
  const isFullRun = selectedIssues.length === ALL_END_TO_END_ISSUES.length
    && ALL_END_TO_END_ISSUES.every((issue) => selectedIssues.includes(issue));
  return {
    source: isFullRun ? 'all' : 'subset',
    selectedIssues,
    availableIssues: [...ALL_END_TO_END_ISSUES],
    isFullRun,
  };
}

function parseIssueSelection(raw: string | undefined): number[] | null {
  if (raw === undefined || !raw.trim()) return null;
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !/^\d+$/.test(entry))) {
    throw new Error(
      `O8_BENCH_E2E_ISSUES must be a comma-separated subset of ${ALL_END_TO_END_ISSUES.join(', ')}`,
    );
  }
  const issues = entries.map(Number);
  const placeholderTasks = issues.map((issue) => ({ issue, label: String(issue) }));
  assertEndToEndTaskSelection(placeholderTasks);
  return issues;
}

export function readEndToEndTasks(
  repoRoot: string,
  issueSelection = process.env.O8_BENCH_E2E_ISSUES,
): EndToEndTask[] {
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
  const selectedIssues = parseIssueSelection(issueSelection);
  if (!selectedIssues) return parsed.tasks;
  const tasksByIssue = new Map(parsed.tasks.map((task) => [task.issue, task]));
  return selectedIssues.map((issue) => ({ ...tasksByIssue.get(issue)! }));
}
