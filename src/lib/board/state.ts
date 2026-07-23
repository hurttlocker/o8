import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getAllRuntimes } from '@/lib/runtimes';
import { validateRepo } from '@/lib/repos/registry';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { AgentSummary } from '@/lib/fleet/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type {
  BoardArchiveReason,
  BoardColumn,
  BoardColumnId,
  BoardColumnView,
  BoardDependency,
  BoardMutation,
  BoardRuntimeOption,
  BoardSnapshot,
  BoardState,
  BoardTask,
  BoardTaskInput,
  BoardTaskPatch,
  BoardTaskView,
} from './types';
import { getDataDir } from '@/lib/data-dir-migration';

const BOARD_STORE_DIR = path.join(getDataDir(), 'boards');
const BOARD_VERSION = 1;
const BOARD_COLUMN_TITLES: Record<BoardColumnId, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  review: 'Review',
  trash: 'Trash',
};
const BOARD_RUNTIME_IDS = new Set(['codex', 'claude-code']);

type BoardRepoContext = {
  repoPath: string;
  repoSlug: string | null;
  defaultBaseBranch: string;
};

const boardLockByRepo = new Map<string, Promise<void>>();

export class BoardConflictError extends Error {
  currentRevision: number;

  constructor(currentRevision: number) {
    super(`Board revision conflict. Current revision is ${currentRevision}.`);
    this.currentRevision = currentRevision;
    this.name = 'BoardConflictError';
  }
}

export class BoardMutationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BoardMutationError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function repoSlugFromRemote(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

function boardRepoKey(repoPath: string) {
  return createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 16);
}

function boardFilePath(repoPath: string) {
  return path.join(BOARD_STORE_DIR, `${boardRepoKey(repoPath)}.json`);
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureBoardStoreDir() {
  await mkdir(BOARD_STORE_DIR, { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await ensureBoardStoreDir();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

async function withBoardLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
  const key = boardRepoKey(repoPath);
  const previous = boardLockByRepo.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  boardLockByRepo.set(key, previous.then(() => current));
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (boardLockByRepo.get(key) === current) {
      boardLockByRepo.delete(key);
    }
  }
}

async function resolveBoardRepoContext(repoPath: string): Promise<BoardRepoContext> {
  const repo = await validateRepo(repoPath);
  return {
    repoPath: repo.localPath,
    repoSlug: repoSlugFromRemote(repo.remoteUrl),
    defaultBaseBranch: repo.defaultBranch,
  };
}

function createEmptyColumns(): BoardColumn[] {
  return (Object.keys(BOARD_COLUMN_TITLES) as BoardColumnId[]).map((id) => ({
    id,
    title: BOARD_COLUMN_TITLES[id],
    taskIds: [],
  }));
}

function createEmptyBoardState(context: BoardRepoContext): BoardState {
  return {
    version: BOARD_VERSION,
    revision: 0,
    repoPath: context.repoPath,
    repoSlug: context.repoSlug,
    defaultBaseBranch: context.defaultBaseBranch,
    updatedAt: nowIso(),
    columns: createEmptyColumns(),
    tasks: {},
    dependencies: [],
  };
}

function createTaskId(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'task';
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

// Problem C — intentionally narrower: BoardTask bindings only support codex and claude-code.
// gemini/opencode do not expose owned-session worktree bindings. Extend when a new runtime
// ships worktree-binding support. Do not widen the runtime type here without updating the DB schema.
function normalizeRuntime(value: unknown): 'codex' | 'claude-code' {
  return value === 'claude-code' ? 'claude-code' : 'codex';
}

function normalizeArchivedRuntime(raw: unknown, archivedAt?: string | null): BoardTask['archivedRuntime'] {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<NonNullable<BoardTask['archivedRuntime']>>;
  const hasRuntimeBinding = Boolean(
    value.runtimeSurfaceId
    || value.sessionId
    || value.worktreeId
    || value.worktreePath,
  );
  if (!hasRuntimeBinding && value.runtime !== 'claude-code' && value.runtime !== 'codex') {
    return null;
  }

  return {
    runtime: value.runtime === 'claude-code' ? 'claude-code' : value.runtime === 'codex' ? 'codex' : null,
    runtimeSurfaceId: typeof value.runtimeSurfaceId === 'string' ? value.runtimeSurfaceId : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    worktreeId: typeof value.worktreeId === 'string' ? value.worktreeId : null,
    worktreePath: typeof value.worktreePath === 'string' ? value.worktreePath : null,
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : archivedAt ?? null,
  };
}

function normalizeTask(raw: unknown, defaultBaseBranch: string): BoardTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<BoardTask>;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!id || !title) return null;

  const prompt = typeof value.prompt === 'string' && value.prompt.trim()
    ? value.prompt.trim()
    : title;
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : nowIso();
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt;
  const baseBranch = typeof value.baseBranch === 'string' && value.baseBranch.trim()
    ? value.baseBranch.trim()
    : defaultBaseBranch;
  const bindings = (value.bindings && typeof value.bindings === 'object'
    ? value.bindings
    : {}) as Partial<BoardTask['bindings']>;
  const automation = (value.automation && typeof value.automation === 'object'
    ? value.automation
    : {}) as Partial<BoardTask['automation']>;

  return {
    id,
    title,
    prompt,
    preferredRuntime: normalizeRuntime(value.preferredRuntime),
    baseBranch,
    notes: typeof value.notes === 'string' ? value.notes : null,
    workflowState: typeof value.workflowState === 'string' ? value.workflowState : null,
    archiveReason:
      value.archiveReason === 'completed' || value.archiveReason === 'discarded'
        ? value.archiveReason
        : null,
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : null,
    archivedFromColumn:
      value.archivedFromColumn === 'backlog'
      || value.archivedFromColumn === 'in_progress'
      || value.archivedFromColumn === 'review'
        ? value.archivedFromColumn
        : null,
    archivedRuntime: normalizeArchivedRuntime(value.archivedRuntime, typeof value.archivedAt === 'string' ? value.archivedAt : null),
    createdAt,
    updatedAt,
    bindings: {
      runtime: bindings.runtime === 'claude-code' ? 'claude-code' : bindings.runtime === 'codex' ? 'codex' : null,
      runtimeSurfaceId: typeof bindings.runtimeSurfaceId === 'string' ? bindings.runtimeSurfaceId : null,
      sessionId: typeof bindings.sessionId === 'string' ? bindings.sessionId : null,
      worktreeId: typeof bindings.worktreeId === 'string' ? bindings.worktreeId : null,
      worktreePath: typeof bindings.worktreePath === 'string' ? bindings.worktreePath : null,
      issueId: Number.isFinite(bindings.issueId) ? Number(bindings.issueId) : null,
      prId: Number.isFinite(bindings.prId) ? Number(bindings.prId) : null,
    },
    automation: {
      startInPlanMode: Boolean(automation.startInPlanMode),
      autoReviewEnabled: Boolean(automation.autoReviewEnabled),
      autoReviewMode:
        automation.autoReviewMode === 'pr' || automation.autoReviewMode === 'move_to_trash'
          ? automation.autoReviewMode
          : automation.autoReviewMode === 'commit'
            ? 'commit'
            : undefined,
    },
  };
}

function normalizeBoardState(raw: unknown, context: BoardRepoContext): BoardState {
  const fallback = createEmptyBoardState(context);
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const value = raw as Partial<BoardState>;
  const tasks: Record<string, BoardTask> = {};
  const rawTasks = value.tasks && typeof value.tasks === 'object' ? value.tasks : {};
  for (const [taskId, rawTask] of Object.entries(rawTasks)) {
    const task = normalizeTask(rawTask, context.defaultBaseBranch);
    if (task && task.id === taskId) {
      tasks[taskId] = task;
    }
  }

  const rawColumns = Array.isArray(value.columns) ? value.columns : [];
  const taskIdsInColumns = new Set<string>();
  const columns = createEmptyColumns().map((column) => {
    const matched = rawColumns.find((entry) => entry && typeof entry === 'object' && entry.id === column.id) as Partial<BoardColumn> | undefined;
    const rawTaskIds = Array.isArray(matched?.taskIds) ? matched?.taskIds : [];
    const taskIds = rawTaskIds
      .filter((taskId): taskId is string => typeof taskId === 'string' && Boolean(tasks[taskId]))
      .filter((taskId) => {
        if (taskIdsInColumns.has(taskId)) return false;
        taskIdsInColumns.add(taskId);
        return true;
      });
    return {
      ...column,
      taskIds,
    };
  });

  for (const taskId of Object.keys(tasks)) {
    if (!taskIdsInColumns.has(taskId)) {
      columns[0]?.taskIds.push(taskId);
    }
  }

  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies
        .filter((dependency): dependency is BoardDependency => (
          Boolean(dependency)
          && typeof dependency.id === 'string'
          && typeof dependency.fromTaskId === 'string'
          && typeof dependency.toTaskId === 'string'
        ))
        .map((dependency) => ({
          id: dependency.id,
          fromTaskId: dependency.fromTaskId,
          toTaskId: dependency.toTaskId,
          createdAt: typeof dependency.createdAt === 'string' ? dependency.createdAt : nowIso(),
        }))
    : [];

  return sanitizeBoardState({
    version: BOARD_VERSION,
    revision: Number.isFinite(value.revision) ? Math.max(0, Number(value.revision)) : 0,
    repoPath: context.repoPath,
    repoSlug: context.repoSlug,
    defaultBaseBranch: context.defaultBaseBranch,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
    columns,
    tasks,
    dependencies,
  });
}

function getColumn(state: BoardState, columnId: BoardColumnId) {
  const matched = state.columns.find((column) => column.id === columnId);
  if (!matched) {
    throw new BoardMutationError('missing_column', `Column ${columnId} is not available.`);
  }
  return matched;
}

function getTaskColumnId(state: BoardState, taskId: string): BoardColumnId | null {
  for (const column of state.columns) {
    if (column.taskIds.includes(taskId)) return column.id;
  }
  return null;
}

function removeTaskFromColumns(state: BoardState, taskId: string) {
  for (const column of state.columns) {
    column.taskIds = column.taskIds.filter((entry) => entry !== taskId);
  }
}

function insertTaskIntoColumn(state: BoardState, taskId: string, columnId: BoardColumnId, index?: number) {
  const column = getColumn(state, columnId);
  const nextIndex = typeof index === 'number'
    ? Math.max(0, Math.min(index, column.taskIds.length))
    : 0;
  column.taskIds.splice(nextIndex, 0, taskId);
}

function resolveDependencyEndpoints(
  state: BoardState,
  firstTaskId: string,
  secondTaskId: string,
): { fromTaskId: string; toTaskId: string } {
  if (firstTaskId === secondTaskId) {
    throw new BoardMutationError('same_task', 'Tasks cannot depend on themselves.');
  }
  const firstColumnId = getTaskColumnId(state, firstTaskId);
  const secondColumnId = getTaskColumnId(state, secondTaskId);
  if (!firstColumnId || !secondColumnId) {
    throw new BoardMutationError('missing_task', 'Both tasks must exist before linking them.');
  }
  if (firstColumnId === 'trash' || secondColumnId === 'trash') {
    throw new BoardMutationError('trash_task', 'Trashed tasks cannot participate in dependencies.');
  }
  const firstIsBacklog = firstColumnId === 'backlog';
  const secondIsBacklog = secondColumnId === 'backlog';
  if (!firstIsBacklog && !secondIsBacklog) {
    throw new BoardMutationError('non_backlog', 'Dependencies are only created from backlog tasks in this slice.');
  }
  return firstIsBacklog
    ? { fromTaskId: firstTaskId, toTaskId: secondTaskId }
    : { fromTaskId: secondTaskId, toTaskId: firstTaskId };
}

function hasDependencyCycle(state: BoardState, candidateFromTaskId: string, candidateToTaskId: string) {
  const visited = new Set<string>();
  const walk = (taskId: string): boolean => {
    if (taskId === candidateFromTaskId) return true;
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    return state.dependencies
      .filter((dependency) => dependency.fromTaskId === taskId)
      .some((dependency) => walk(dependency.toTaskId));
  };
  return walk(candidateToTaskId);
}

function sanitizeBoardState(state: BoardState): BoardState {
  const columns = createEmptyColumns().map((column) => {
    const current = state.columns.find((entry) => entry.id === column.id);
    const seen = new Set<string>();
    const taskIds = (current?.taskIds ?? []).filter((taskId) => {
      if (!state.tasks[taskId] || seen.has(taskId)) return false;
      seen.add(taskId);
      return true;
    });
    return {
      ...column,
      taskIds,
    };
  });

  const orderedTaskIds = new Set(columns.flatMap((column) => column.taskIds));
  for (const taskId of Object.keys(state.tasks)) {
    if (!orderedTaskIds.has(taskId)) {
      columns[0]?.taskIds.push(taskId);
    }
  }

  const dependencyPairs = new Set<string>();
  const dependencies = state.dependencies.filter((dependency) => {
    const fromTask = state.tasks[dependency.fromTaskId];
    const toTask = state.tasks[dependency.toTaskId];
    if (!fromTask || !toTask || dependency.fromTaskId === dependency.toTaskId) {
      return false;
    }
    if (
      !columns.some((column) => column.taskIds.includes(dependency.fromTaskId))
      || !columns.some((column) => column.taskIds.includes(dependency.toTaskId))
    ) {
      return false;
    }
    const pair = `${dependency.fromTaskId}::${dependency.toTaskId}`;
    if (dependencyPairs.has(pair)) {
      return false;
    }
    dependencyPairs.add(pair);
    return true;
  });

  return {
    ...state,
    columns,
    dependencies,
  };
}

async function readBoardState(context: BoardRepoContext): Promise<BoardState> {
  const filePath = boardFilePath(context.repoPath);
  if (!(await pathExists(filePath))) {
    return createEmptyBoardState(context);
  }

  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return createEmptyBoardState(context);
  }

  return normalizeBoardState(JSON.parse(raw), context);
}

async function writeBoardState(state: BoardState) {
  await writeJsonAtomic(boardFilePath(state.repoPath), state);
}

export async function loadBoardState(repoPath: string) {
  const context = await resolveBoardRepoContext(repoPath);
  return readBoardState(context);
}

export async function updateBoardState(
  repoPath: string,
  updater: (state: BoardState) => BoardState | Promise<BoardState>,
  options: { expectedRevision?: number } = {},
) {
  const context = await resolveBoardRepoContext(repoPath);

  return withBoardLock(context.repoPath, async () => {
    const current = await readBoardState(context);
    if (typeof options.expectedRevision === 'number' && current.revision !== options.expectedRevision) {
      throw new BoardConflictError(current.revision);
    }

    const updated = sanitizeBoardState(await updater(structuredClone(current)));
    const next: BoardState = {
      ...updated,
      version: BOARD_VERSION,
      repoPath: context.repoPath,
      repoSlug: context.repoSlug,
      defaultBaseBranch: context.defaultBaseBranch,
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    await writeBoardState(next);
    return next;
  });
}

function applyTaskPatch(task: BoardTask, patch: BoardTaskPatch, defaultBaseBranch: string): BoardTask {
  const title = typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : task.title;
  const prompt = typeof patch.prompt === 'string'
    ? (patch.prompt.trim() || title)
    : task.prompt;
  const baseBranch = typeof patch.baseBranch === 'string'
    ? (patch.baseBranch.trim() || defaultBaseBranch)
    : task.baseBranch;

  return {
    ...task,
    title,
    prompt,
    preferredRuntime: patch.preferredRuntime ? normalizeRuntime(patch.preferredRuntime) : task.preferredRuntime,
    baseBranch,
    workflowState: patch.workflowState === undefined ? task.workflowState : patch.workflowState,
    updatedAt: nowIso(),
    automation: {
      ...task.automation,
      startInPlanMode:
        patch.startInPlanMode === undefined ? task.automation.startInPlanMode : Boolean(patch.startInPlanMode),
    },
    bindings: {
      ...task.bindings,
      ...(patch.issueId === undefined ? {} : { issueId: patch.issueId ?? null }),
      ...(patch.prId === undefined ? {} : { prId: patch.prId ?? null }),
      ...(patch.bindings ?? {}),
    },
  };
}

function createBoardTask(state: BoardState, input: BoardTaskInput): BoardTask {
  const title = input.title.trim();
  if (!title) {
    throw new BoardMutationError('missing_title', 'Task title is required.');
  }
  const createdAt = nowIso();
  return {
    id: createTaskId(title),
    title,
    prompt: input.prompt?.trim() || title,
    preferredRuntime: normalizeRuntime(input.preferredRuntime),
    baseBranch: input.baseBranch?.trim() || state.defaultBaseBranch,
    notes: null,
    workflowState: 'pending',
    archiveReason: null,
    archivedAt: null,
    archivedFromColumn: null,
    archivedRuntime: null,
    createdAt,
    updatedAt: createdAt,
    bindings: {
      runtime: null,
      runtimeSurfaceId: null,
      sessionId: null,
      worktreeId: null,
      worktreePath: null,
      issueId: input.issueId ?? null,
      prId: input.prId ?? null,
    },
    automation: {
      startInPlanMode: Boolean(input.startInPlanMode),
    },
  };
}

function requireTask(state: BoardState, taskId: string) {
  const task = state.tasks[taskId];
  if (!task) {
    throw new BoardMutationError('missing_task', 'Task not found.');
  }
  return task;
}

function requireTaskColumnId(state: BoardState, taskId: string) {
  const columnId = getTaskColumnId(state, taskId);
  if (!columnId) {
    throw new BoardMutationError('missing_task', 'Task is not placed on the board.');
  }
  return columnId;
}

function moveTaskIntoColumn(state: BoardState, taskId: string, columnId: BoardColumnId, index?: number) {
  removeTaskFromColumns(state, taskId);
  insertTaskIntoColumn(state, taskId, columnId, index);
}

function archiveWorkflowState(reason: BoardArchiveReason) {
  return reason === 'completed' ? 'done' : 'cancelled';
}

function hasActiveRuntimeBindings(task: BoardTask) {
  return Boolean(
    task.bindings.runtime
    || task.bindings.runtimeSurfaceId
    || task.bindings.sessionId
    || task.bindings.worktreeId
    || task.bindings.worktreePath,
  );
}

function clearActiveRuntimeBindings(bindings: BoardTask['bindings']): BoardTask['bindings'] {
  return {
    ...bindings,
    runtime: null,
    runtimeSurfaceId: null,
    sessionId: null,
    worktreeId: null,
    worktreePath: null,
  };
}

function buildArchivedRuntimeSnapshot(task: BoardTask, archivedAt: string): BoardTask['archivedRuntime'] {
  if (!hasActiveRuntimeBindings(task)) {
    return task.archivedRuntime ?? null;
  }

  return {
    runtime: task.bindings.runtime ?? null,
    runtimeSurfaceId: task.bindings.runtimeSurfaceId ?? null,
    sessionId: task.bindings.sessionId ?? null,
    worktreeId: task.bindings.worktreeId ?? null,
    worktreePath: task.bindings.worktreePath ?? null,
    archivedAt,
  };
}

async function resolveLiveTaskView(state: BoardState, taskId: string): Promise<BoardTaskView> {
  const columnId = requireTaskColumnId(state, taskId);
  const [agents, worktrees] = await Promise.all([
    getRuntimeInventorySnapshot()
      .then((snapshot) => snapshot.agents)
      .catch(() => [] as AgentSummary[]),
    getWorktreeManager(state.repoPath).list().catch(() => [] as WorktreeInfo[]),
  ]);
  return buildBoardTaskView(
    state,
    taskId,
    columnId,
    new Set(getStartableTaskIds(state)),
    agents,
    new Map(worktrees.map((worktree) => [worktree.id, worktree])),
  );
}

export async function applyBoardMutation(state: BoardState, mutation: BoardMutation): Promise<BoardState> {
  switch (mutation.type) {
    case 'create_task': {
      const task = createBoardTask(state, mutation.task);
      state.tasks[task.id] = task;
      insertTaskIntoColumn(state, task.id, mutation.columnId ?? 'backlog', 0);
      return state;
    }
    case 'update_task': {
      const task = requireTask(state, mutation.taskId);
      state.tasks[mutation.taskId] = applyTaskPatch(task, mutation.patch, state.defaultBaseBranch);
      return state;
    }
    case 'reorder_task': {
      requireTask(state, mutation.taskId);
      const currentColumnId = requireTaskColumnId(state, mutation.taskId);
      if (currentColumnId !== mutation.columnId) {
        throw new BoardMutationError('invalid_reorder', 'Tasks can only be reordered within their current column.');
      }
      const column = getColumn(state, mutation.columnId);
      const currentIndex = column.taskIds.indexOf(mutation.taskId);
      if (currentIndex < 0) {
        throw new BoardMutationError('missing_task', 'Task is not present in the requested column.');
      }

      const desiredIndexBeforeRemoval = typeof mutation.toIndex === 'number'
        ? Math.max(0, Math.min(mutation.toIndex, column.taskIds.length))
        : column.taskIds.length;
      const nextTaskIds = column.taskIds.filter((taskId) => taskId !== mutation.taskId);
      let nextIndex = desiredIndexBeforeRemoval;
      if (currentIndex < desiredIndexBeforeRemoval) {
        nextIndex -= 1;
      }
      nextIndex = Math.max(0, Math.min(nextIndex, nextTaskIds.length));

      if (nextIndex === currentIndex) {
        return state;
      }

      nextTaskIds.splice(nextIndex, 0, mutation.taskId);
      column.taskIds = nextTaskIds;
      state.tasks[mutation.taskId] = {
        ...state.tasks[mutation.taskId],
        updatedAt: nowIso(),
      };
      return state;
    }
    case 'mark_review_ready': {
      const currentTask = requireTask(state, mutation.taskId);
      const currentColumnId = requireTaskColumnId(state, mutation.taskId);
      if (currentColumnId !== 'in_progress') {
        throw new BoardMutationError('invalid_review_ready', 'Only in-progress tasks can be marked review-ready.');
      }

      const liveTask = await resolveLiveTaskView(state, mutation.taskId);
      if (!liveTask.reviewReady) {
        throw new BoardMutationError(
          'not_review_ready',
          'This task is not review-ready yet. Wait for a real review signal from the runtime or worktree.',
        );
      }

      moveTaskIntoColumn(state, mutation.taskId, 'review', 0);
      state.tasks[mutation.taskId] = {
        ...currentTask,
        workflowState: 'done_with_concerns',
        updatedAt: nowIso(),
      };
      return state;
    }
    case 'archive_task': {
      const currentTask = requireTask(state, mutation.taskId);
      const currentColumnId = requireTaskColumnId(state, mutation.taskId);
      if (currentColumnId === 'trash') {
        throw new BoardMutationError('already_archived', 'Task is already archived.');
      }
      if (mutation.reason === 'completed' && currentColumnId !== 'review') {
        throw new BoardMutationError(
          'invalid_archive_reason',
          'Only review tasks can be archived as completed.',
        );
      }

      const archivedAt = nowIso();
      moveTaskIntoColumn(state, mutation.taskId, 'trash', 0);
      state.tasks[mutation.taskId] = {
        ...currentTask,
        workflowState: archiveWorkflowState(mutation.reason),
        archiveReason: mutation.reason,
        archivedAt,
        archivedFromColumn: currentColumnId,
        archivedRuntime: buildArchivedRuntimeSnapshot(currentTask, archivedAt),
        updatedAt: archivedAt,
        bindings: clearActiveRuntimeBindings(currentTask.bindings),
      };
      return state;
    }
    case 'restore_task': {
      const currentTask = requireTask(state, mutation.taskId);
      const currentColumnId = requireTaskColumnId(state, mutation.taskId);
      if (currentColumnId !== 'trash') {
        throw new BoardMutationError('invalid_restore', 'Only archived tasks can be restored.');
      }

      moveTaskIntoColumn(state, mutation.taskId, 'backlog', mutation.toIndex ?? 0);
      state.tasks[mutation.taskId] = {
        ...currentTask,
        workflowState: 'pending',
        archiveReason: null,
        archivedAt: null,
        archivedFromColumn: null,
        updatedAt: nowIso(),
        bindings: clearActiveRuntimeBindings(currentTask.bindings),
      };
      return state;
    }
    case 'add_dependency': {
      const endpoints = resolveDependencyEndpoints(state, mutation.fromTaskId, mutation.toTaskId);
      const pairKey = `${endpoints.fromTaskId}::${endpoints.toTaskId}`;
      if (state.dependencies.some((dependency) => `${dependency.fromTaskId}::${dependency.toTaskId}` === pairKey)) {
        throw new BoardMutationError('duplicate_dependency', 'This dependency already exists.');
      }
      if (hasDependencyCycle(state, endpoints.fromTaskId, endpoints.toTaskId)) {
        throw new BoardMutationError('dependency_cycle', 'This dependency would create a cycle.');
      }
      state.dependencies.push({
        id: `dep-${randomUUID().slice(0, 8)}`,
        fromTaskId: endpoints.fromTaskId,
        toTaskId: endpoints.toTaskId,
        createdAt: nowIso(),
      });
      return sanitizeBoardState(state);
    }
    case 'remove_dependency': {
      state.dependencies = state.dependencies.filter((dependency) => dependency.id !== mutation.dependencyId);
      return state;
    }
    default:
      return state;
  }
}

export async function mutateBoardState(
  repoPath: string,
  mutation: BoardMutation,
  options: { expectedRevision?: number } = {},
) {
  return updateBoardState(repoPath, (state) => applyBoardMutation(state, mutation), options);
}

function isDependencyActivelyBlocking(state: BoardState, dependency: BoardDependency) {
  const blockerColumnId = getTaskColumnId(state, dependency.toTaskId);
  return blockerColumnId !== null && blockerColumnId !== 'trash';
}

export function getStartableTaskIds(state: BoardState) {
  const blockedTaskIds = new Set(
    state.dependencies
      .filter((dependency) => isDependencyActivelyBlocking(state, dependency))
      .map((dependency) => dependency.fromTaskId),
  );
  return getColumn(state, 'backlog').taskIds.filter((taskId) => {
    const task = state.tasks[taskId];
    return Boolean(task) && !blockedTaskIds.has(taskId) && !hasActiveRuntimeBindings(task);
  });
}

function findRuntimeSessionForTask(task: BoardTask, agents: AgentSummary[]) {
  const surfaceId = task.bindings.runtimeSurfaceId || task.bindings.sessionId;
  if (!surfaceId) return null;
  return agents.find((agent) => (
    agent.runtimeSurface?.id === surfaceId
    || agent.sessionKey === surfaceId
    || agent.id === surfaceId
  )) ?? null;
}

function buildAvailableRuntimeOptions(): BoardRuntimeOption[] {
  const options: BoardRuntimeOption[] = [];

  for (const runtime of getAllRuntimes()) {
    const runtimeId = runtime.id;
    if (!runtime.capabilities.launch) continue;
    // BoardRuntimeId intentionally only includes codex + claude-code.
    // gemini and opencode are dispatched via OrchestratorRuntime through
    // the lane system, not through the board's worktree-launch path.
    if (runtimeId !== 'codex' && runtimeId !== 'claude-code') continue;
    if (!BOARD_RUNTIME_IDS.has(runtimeId)) continue;
    const boardRuntimeId = runtimeId === 'claude-code' ? 'claude-code' : 'codex';

    options.push({
      id: boardRuntimeId,
      label: runtime.displayName,
      supportsWorktree: true,
      launchBehavior: boardRuntimeId === 'codex' ? 'owned' : 'provider',
    });
  }

  return options;
}

function buildBoardTaskView(
  state: BoardState,
  taskId: string,
  columnId: BoardColumnId,
  startableTaskIds: Set<string>,
  agents: AgentSummary[],
  worktreesById: Map<string, WorktreeInfo>,
): BoardTaskView {
  const task = state.tasks[taskId];
  const blockedByTaskIds = state.dependencies
    .filter((dependency) => isDependencyActivelyBlocking(state, dependency))
    .filter((dependency) => dependency.fromTaskId === taskId)
    .map((dependency) => dependency.toTaskId)
    .filter((dependencyTaskId) => Boolean(state.tasks[dependencyTaskId]));
  const dependentTaskIds = state.dependencies
    .filter((dependency) => dependency.toTaskId === taskId)
    .map((dependency) => dependency.fromTaskId)
    .filter((dependencyTaskId) => Boolean(state.tasks[dependencyTaskId]));
  const runtimeSession = findRuntimeSessionForTask(task, agents);
  const worktree = task.bindings.worktreeId ? worktreesById.get(task.bindings.worktreeId) ?? null : null;
  const reviewReady = columnId === 'review'
    || (
      columnId === 'in_progress'
      && (
        runtimeSession?.status === 'reviewing'
        || (
          runtimeSession?.status === 'idle'
          && Boolean(worktree?.dirtyFiles.length)
        )
      )
    );

  return {
    ...task,
    columnId,
    blocked: columnId === 'backlog' && blockedByTaskIds.length > 0,
    blockedByTaskIds,
    blockedByTitles: blockedByTaskIds.map((dependencyTaskId) => state.tasks[dependencyTaskId]?.title ?? dependencyTaskId),
    dependentTaskIds,
    dependencyIds: state.dependencies
      .filter((dependency) => dependency.fromTaskId === taskId || dependency.toTaskId === taskId)
      .map((dependency) => dependency.id),
    startable: startableTaskIds.has(taskId),
    reviewReady,
    runtimeSession,
    worktree,
  };
}

export async function getBoardSnapshot(repoPath: string): Promise<BoardSnapshot> {
  const state = await loadBoardState(repoPath);
  const [runtimeSnapshot, worktrees] = await Promise.all([
    getRuntimeInventorySnapshot(),
    getWorktreeManager(state.repoPath).list().catch(() => []),
  ]);

  const startableTaskIds = new Set(getStartableTaskIds(state));
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const columns: BoardColumnView[] = state.columns.map((column) => ({
    id: column.id,
    title: column.title,
    tasks: column.taskIds
      .map((taskId) => buildBoardTaskView(state, taskId, column.id, startableTaskIds, runtimeSnapshot.agents, worktreesById))
      .filter(Boolean),
  }));

  return {
    state,
    columns,
    startableTaskIds: [...startableTaskIds],
    availableRuntimes: buildAvailableRuntimeOptions(),
  };
}
