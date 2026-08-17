import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

interface PromotionInput {
  cycle: number;
  dataDir: string;
  repoPath: string;
  packetId: string;
  surfaceId: string;
  repoId?: string;
  laneId?: string;
  workspacePath?: string;
}

interface WorktreeResponse {
  worktree?: {
    id: string;
    path: string;
    branch: string;
    dependencyRecipeKey?: string;
  };
  error?: unknown;
}

const action = process.argv[2];
const parsedInput = JSON.parse(process.env.O8_PROMOTION_INPUT ?? 'null') as PromotionInput | null;
if (!parsedInput) throw new Error('O8_PROMOTION_INPUT is required.');
const input: PromotionInput = parsedInput;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function directoryContainsBytes(candidate: string, needle: string): boolean {
  const bytes = Buffer.from(needle);
  const visit = (entryPath: string): boolean => {
    const entry = lstatSync(entryPath);
    if (entry.isSymbolicLink()) return false;
    if (entry.isFile()) return readFileSync(entryPath).includes(bytes);
    if (!entry.isDirectory()) return false;
    return readdirSync(entryPath).some((name) => visit(path.join(entryPath, name)));
  };
  return visit(candidate);
}

function installEvidence(workspacePath: string) {
  const nodeModules = path.join(workspacePath, 'node_modules');
  const entry = lstatSync(nodeModules);
  const receipt = JSON.parse(readFileSync(
    path.join(nodeModules, 'postinstall-private', 'receipt.json'),
    'utf8',
  )) as Record<string, string | null>;
  const effects = readFileSync(
    path.join(nodeModules, 'postinstall-private', 'effects.log'),
    'utf8',
  ).trim().split('\n').filter(Boolean);
  return {
    receipt,
    effectCount: effects.length,
    privateWritableDirectory: entry.isDirectory()
      && !entry.isSymbolicLink()
      && (entry.mode & 0o200) !== 0,
  };
}

async function registerLifecycle(): Promise<void> {
  if (!input.workspacePath || !input.repoId) throw new Error('Lifecycle input is incomplete.');
  const { registerOwnedSessionLifecycleHandler } = await import(
    '@/lib/runtimes/shared/owned-session-lifecycle'
  );
  let version = 1;
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'codex',
    surfaceIdPrefix: 'thin-promotion-owned:',
    commandLabel: 'thin-workspace-promotion',
    resolveRoot: () => input.dataDir,
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => ({
      surfaceId: input.surfaceId,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: `packet:${input.packetId}`,
        repositoryUuid: input.repoId!,
        packetId: input.packetId,
        cwd: input.workspacePath!,
        version,
        verifiedAt: new Date().toISOString(),
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    }),
    rebindWorkspace: async (_surfaceId, next) => {
      if (next.expectedVersion !== version || next.expectedCwd !== input.workspacePath) {
        return { status: 'conflict', receipt: null, note: 'binding mismatch' };
      }
      version += 1;
      return {
        status: 'rebound',
        receipt: {
          surfaceId: input.surfaceId,
          runtimeId: 'codex',
          sessionState: 'active',
          binding: {
            logicalWorkspaceId: `packet:${input.packetId}`,
            repositoryUuid: input.repoId!,
            packetId: input.packetId,
            cwd: next.nextCwd,
            version,
            verifiedAt: new Date().toISOString(),
          },
          activeRun: null,
          retainedRuns: [],
          retainedRunsComplete: true,
          retainedRunTotal: 0,
        },
      };
    },
  });
}

async function requestWorkspaceAction(routeAction: 'park' | 'restore') {
  await registerLifecycle();
  const { getOrCreateWsToken } = await import('@/lib/ws-auth');
  const { POST } = await import('@/app/api/orchestrator/workspace/route');
  const startedAt = performance.now();
  const response = await POST(new NextRequest('http://127.0.0.1/api/orchestrator/workspace', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${getOrCreateWsToken().trim()}`,
      'content-type': 'application/json',
      host: '127.0.0.1',
      'x-o8-client-addr': '127.0.0.1',
    },
    body: JSON.stringify({
      action: routeAction,
      packetId: input.packetId,
      clientMutationId: `thin-promotion-${input.cycle}-${routeAction}`,
    }),
  }));
  return {
    durationMs: performance.now() - startedAt,
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function create() {
  const { addRepo } = await import('@/lib/repos/registry');
  const { createLane } = await import('@/lib/lane/registry');
  const { getSqlite } = await import('@/lib/db');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { POST } = await import('@/app/api/worktrees/route');
  const repo = await addRepo(input.repoPath);
  const response = await POST(new NextRequest('http://127.0.0.1/api/worktrees', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({
      repo: input.repoPath,
      agentType: 'codex',
      taskName: `thin promotion ${input.cycle}`,
      baseBranch: 'main',
      isolationPreference: 'git-worktree',
    }),
  }));
  const body = await response.json() as WorktreeResponse;
  if (response.status !== 201 || !body.worktree) {
    return { status: response.status, body };
  }
  const worktree = body.worktree;
  writeFileSync(path.join(worktree.path, 'tracked.txt'), `reviewed cycle ${input.cycle}\n`);
  git(worktree.path, 'add', 'tracked.txt');
  git(worktree.path, 'commit', '-qm', `review cycle ${input.cycle}`);
  const reviewedHead = git(worktree.path, 'rev-parse', 'HEAD');
  const reviewedTree = git(worktree.path, 'rev-parse', 'HEAD^{tree}');
  const fullDiff = execFileSync(
    'git',
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'main', 'HEAD', '--'],
    { cwd: worktree.path, encoding: 'utf8' },
  );
  await withWorktreeMetaTransaction(input.repoPath, async (transaction) => {
    const entry = (await transaction.readAll())[worktree.id];
    if (!entry) throw new Error('Created worktree metadata was not persisted.');
    await transaction.save(worktree.id, { ...entry, sessionKey: input.surfaceId });
  });
  const lane = createLane({
    repoPath: repo.localPath,
    branch: worktree.branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: input.packetId,
    sessionKey: input.surfaceId,
    worktreePath: worktree.path,
    ownership: 'managed',
  });
  getSqlite().prepare('UPDATE lanes SET status = ? WHERE id = ?').run('reviewing', lane.id);
  return {
    status: response.status,
    repo: { id: repo.id, installOnCreateWorkspace: repo.setup.installOnCreateWorkspace },
    worktree,
    laneId: lane.id,
    reviewedHead,
    reviewedTree,
    fullDiff,
    install: installEvidence(worktree.path),
    rootNodeModulesAbsent: !existsSync(path.join(input.repoPath, 'node_modules')),
  };
}

async function park() {
  if (!input.repoId || !input.laneId || !input.workspacePath) {
    throw new Error('Park input is incomplete.');
  }
  const route = await requestWorkspaceAction('park');
  const { getLane } = await import('@/lib/lane/registry');
  const { readLaneReviewDiff } = await import('@/lib/lane/review-source');
  const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import(
    '@/lib/worktree/snapshot-state'
  );
  const lane = getLane(input.laneId);
  if (!lane) throw new Error('Lane was not persisted for parked review.');
  const snapshot = getWorkspaceSnapshot(input.repoId, input.packetId);
  if (!snapshot) {
    throw new Error(`Parked snapshot was not persisted: ${JSON.stringify(route)}`);
  }
  const review = await readLaneReviewDiff(lane);
  const transition = listWorkspaceSnapshotTransitions(input.repoId, input.packetId)
    .find((entry) => entry.transitionId === `thin-promotion-${input.cycle}-park:parked`);
  const receipt = transition?.receipt ?? {};
  const afterAvailableBytes = typeof receipt.afterAvailableBytes === 'number'
    ? receipt.afterAvailableBytes
    : null;
  const reclaimedAvailableBytes = typeof receipt.reclaimedAvailableBytes === 'number'
    ? receipt.reclaimedAvailableBytes
    : null;
  return {
    route,
    pathAbsent: !existsSync(input.workspacePath),
    snapshot,
    review,
    bytes: {
      logicalBefore: typeof receipt.logicalBytesBefore === 'number' ? receipt.logicalBytesBefore : null,
      logicalAfter: 0,
      availableBefore: afterAvailableBytes !== null && reclaimedAvailableBytes !== null
        ? afterAvailableBytes - reclaimedAvailableBytes
        : null,
      availableAfter: afterAvailableBytes,
      reclaimedAvailable: reclaimedAvailableBytes,
    },
  };
}

async function restore() {
  if (!input.repoId || !input.laneId || !input.workspacePath) {
    throw new Error('Restore input is incomplete.');
  }
  const route = await requestWorkspaceAction('restore');
  const { getLane } = await import('@/lib/lane/registry');
  const { readLaneReviewDiff } = await import('@/lib/lane/review-source');
  const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import(
    '@/lib/worktree/snapshot-state'
  );
  const lane = getLane(input.laneId);
  if (!lane) throw new Error('Lane was not persisted for restored review.');
  const snapshot = getWorkspaceSnapshot(input.repoId, input.packetId);
  if (!snapshot) throw new Error('Restored snapshot was not persisted.');
  const review = await readLaneReviewDiff(lane);
  const setupTransition = listWorkspaceSnapshotTransitions(input.repoId, input.packetId)
    .findLast((entry) => entry.toState === 'materialized' && entry.receipt?.setupRecipeKey);
  const install = installEvidence(input.workspacePath);
  const authority = typeof install.receipt.cache === 'string'
    ? path.resolve(install.receipt.cache)
    : null;
  return {
    route,
    pathPresent: existsSync(input.workspacePath),
    snapshot,
    review,
    head: git(input.workspacePath, 'rev-parse', 'HEAD'),
    tree: git(input.workspacePath, 'rev-parse', 'HEAD^{tree}'),
    tracked: readFileSync(path.join(input.workspacePath, 'tracked.txt'), 'utf8'),
    install,
    setupRecipeKey: setupTransition?.receipt?.setupRecipeKey ?? null,
    rootNodeModulesAbsent: !existsSync(path.join(input.repoPath, 'node_modules')),
    cacheAuthorityPrivate: authority === null ? false : (() => {
      const entry = lstatSync(authority);
      return entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0;
    })(),
    cacheContainsSecret: authority === null
      ? true
      : directoryContainsBytes(authority, process.env.NPM_TOKEN ?? ''),
    cacheContainsPrivateMutation: authority === null
      ? true
      : directoryContainsBytes(authority, 'private-workspace-mutation'),
  };
}

async function main(): Promise<void> {
  const { closeDb } = await import('@/lib/db');
  try {
    const result = action === 'create'
      ? await create()
      : action === 'park'
        ? await park()
        : action === 'restore'
          ? await restore()
          : (() => { throw new Error(`Unknown promotion action: ${action}`); })();
    process.stdout.write(`O8_PROMOTION_RESULT ${JSON.stringify(result)}\n`);
  } finally {
    closeDb();
  }
}

void main().catch((error) => {
  console.error('[thin-workspaces-promotion] Child failed.', error);
  process.exitCode = 1;
});
