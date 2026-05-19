/**
 * `o8 task …` — packet/lane task-pool projection for agents and humans.
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

type TaskPoolGroup = 'ready' | 'running' | 'review' | 'blocked' | 'done';

interface TaskPoolRepoSummary {
  id: string;
  name: string;
  localPath: string;
  role: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

interface TaskPoolProjectSummary {
  id: string;
  name: string;
  slug: string;
  mainRepo: TaskPoolRepoSummary | null;
  currentRepo: TaskPoolRepoSummary | null;
  relatedRepos: TaskPoolRepoSummary[];
}

interface TaskPoolLaneSummary {
  id: string;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  baseBranch: string;
  sessionKey: string | null;
  worktreePath: string | null;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

interface TaskPoolTask {
  id: string;
  packetId: string | null;
  laneId: string | null;
  title: string;
  summary: string;
  group: TaskPoolGroup;
  status: string;
  runtime: string;
  branch: string | null;
  baseBranch: string | null;
  repoPath: string | null;
  repoName: string | null;
  queueState: string | null;
  releaseState: string | null;
  blockedReason: string | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  allowedFiles: string[];
  project: TaskPoolProjectSummary | null;
  lane: TaskPoolLaneSummary | null;
  taskBrief?: string;
}

interface TaskPool {
  schema: 'o8/task.pool/v1';
  tasks: TaskPoolTask[];
  groups: Record<TaskPoolGroup, TaskPoolTask[]>;
  counts: Record<TaskPoolGroup, number>;
}

interface TaskDetail {
  schema: 'o8/task.detail/v1';
  task: TaskPoolTask;
}

function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

function readFlagValue(rest: string[], name: string): string | null {
  const index = rest.indexOf(name);
  if (index === -1) return null;
  const value = rest[index + 1];
  return value && !value.startsWith('-') ? value : null;
}

function taskQuery(rest: string[]): string {
  const params = new URLSearchParams();
  if (hasFlag(rest, '--include-done')) params.set('includeDone', 'true');
  if (hasFlag(rest, '--include-brief')) params.set('includeBrief', 'true');
  const projectId = readFlagValue(rest, '--project');
  if (projectId) params.set('projectId', projectId);
  const repoPath = readFlagValue(rest, '--repo');
  if (repoPath) params.set('repoPath', repoPath);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function taskIdFromRest(rest: string[]): string {
  const id = rest.find((entry) => entry && !entry.startsWith('-'))?.trim();
  if (!id) {
    throw new CliError(
      'invalid_args',
      'o8 task brief <id> needs a packet, lane, or task id.',
      EXIT.INVALID_ARGS,
      'Example: o8 task brief pkt-abc --human',
    );
  }
  return id;
}

function printTaskLine(task: TaskPoolTask): void {
  const id = task.packetId ?? task.laneId ?? task.id;
  const repo = task.repoName ?? 'no repo';
  const project = task.project?.name ?? 'no project';
  process.stdout.write(`  ${id}  ${task.status}  ${repo}  ${project}\n`);
  process.stdout.write(`    ${task.title}\n`);
}

function printHumanTaskPool(pool: TaskPool): void {
  printHumanHeading('task pool');
  printHumanKv([
    ['blocked', String(pool.counts.blocked)],
    ['review', String(pool.counts.review)],
    ['running', String(pool.counts.running)],
    ['ready', String(pool.counts.ready)],
    ['done', String(pool.counts.done)],
  ]);

  for (const group of ['blocked', 'review', 'running', 'ready', 'done'] as TaskPoolGroup[]) {
    printHumanHeading(`${group} (${pool.counts[group]})`);
    if (pool.groups[group].length === 0) {
      process.stdout.write('  (none)\n');
      continue;
    }
    for (const task of pool.groups[group]) {
      printTaskLine(task);
    }
  }
}

function printHumanTaskDetail(detail: TaskDetail): void {
  const { task } = detail;
  printHumanHeading('task');
  printHumanKv([
    ['id', task.id],
    ['packet', task.packetId ?? '(none)'],
    ['lane', task.laneId ?? '(none)'],
    ['group', task.group],
    ['status', task.status],
    ['runtime', task.runtime],
    ['repo', task.repoName ?? '(none)'],
    ['project', task.project?.name ?? '(none)'],
    ['branch', task.branch ?? '(none)'],
  ]);
  process.stdout.write(`\n${task.title}\n`);
  if (task.summary) process.stdout.write(`\n${task.summary}\n`);
  if (task.taskBrief) {
    printHumanHeading('brief');
    process.stdout.write(task.taskBrief.split('\n').map((line) => `  ${line}`).join('\n') + '\n');
  }
}

export async function runTaskList(mode: OutputMode, rest: string[]): Promise<number> {
  const cfg = resolveConfig();
  const res = await apiFetch<TaskPool>(cfg, `/api/tasks${taskQuery(rest)}`);
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty task pool.', EXIT.INVALID_ARGS);
  }
  if (mode.human) {
    printHumanTaskPool(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}

export async function runTaskBrief(mode: OutputMode, rest: string[]): Promise<number> {
  const id = taskIdFromRest(rest);
  const cfg = resolveConfig();
  const res = await apiFetch<TaskDetail>(cfg, `/api/tasks/${encodeURIComponent(id)}${taskQuery(rest)}`);
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty task detail.', EXIT.INVALID_ARGS);
  }
  if (mode.human) {
    printHumanTaskDetail(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}
