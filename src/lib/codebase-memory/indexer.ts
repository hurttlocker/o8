/**
 * Boot indexer for codebase-memory-mcp.
 *
 * Closes #741 (epic #738 Context Engine v2). On o8 boot:
 *   1. Wait for the codebase-memory-mcp binary (#739 download) to be ready.
 *   2. Read ~/.o8/repos.json (the registry from src/lib/repos/registry.ts).
 *   3. For each repo:
 *      - Skip if HEAD matches the persisted last-indexed HEAD (cache hit).
 *      - Skip + mark deferred if the repo on disk is > 500 MB.
 *      - Otherwise queue an index_repository call. Concurrency capped at 2.
 *   4. Persist the new HEAD on success so the next boot is a no-op.
 *
 * The boot pass is fire-and-forget: it returns immediately and runs in the
 * background. Callers (status route, status-bar UI) read the live state via
 * `getIndexState()`.
 *
 * Failure policy: every error is logged with the [codebase-memory] prefix
 * and recorded on the per-repo entry. Nothing here can block the Next.js
 * server boot or hard-crash the process.
 */

import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { resolveCodebaseMemoryBin, waitForCodebaseMemoryBin } from './binary';
import { callCodebaseMemoryTool } from './mcp-client';
import { getRecordedHead, recordIndexedHead } from './state-store';
import type { IndexState, RepoIndexEntry, RepoIndexStatus } from './types';

const execFileAsync = promisify(execFile);

/** Repos larger than this on disk are deferred to manual re-index. */
const DEFAULT_MAX_REPO_SIZE_BYTES = 500 * 1024 * 1024;

/** Concurrent index_repository calls — disk thrash guard. */
const DEFAULT_INDEX_CONCURRENCY = 2;

/** How long to wait for the binary on first boot before giving up. */
const BINARY_WAIT_TIMEOUT_MS = 5 * 60_000;

/** Tool exposed by codebase-memory-mcp (#738/#739). */
const INDEX_TOOL_NAME = 'index_repository';

/** Cap for the manual size walk so a giant node_modules doesn't stall boot.
 *  Raised from 1,500 → 100,000 (#850) — cortex-ide alone has 61,887 entries
 *  after excluding node_modules/.git/target/.next/dist, so the previous cap
 *  deferred our primary dogfood repo on every boot. The walk is fast (sub-
 *  100ms even at 60k entries on SSD) so the cap is only a paranoia bound. */
const SIZE_WALK_ENTRY_CAP = 100_000;

// Live in-process state. Reset on server restart — that's fine since the
// next boot pass repopulates it.
const stateByRepoId = new Map<string, RepoIndexEntry>();
let bootRan = false;
let bootInFlight = false;

function logInfo(msg: string, ...rest: unknown[]) {
  console.log(`[codebase-memory] ${msg}`, ...rest);
}
function logWarn(msg: string, ...rest: unknown[]) {
  console.warn(`[codebase-memory] ${msg}`, ...rest);
}

function setEntry(entry: RepoIndexEntry) {
  stateByRepoId.set(entry.repoId, entry);
}

function patchEntry(repoId: string, patch: Partial<RepoIndexEntry>) {
  const existing = stateByRepoId.get(repoId);
  if (!existing) return;
  setEntry({ ...existing, ...patch });
}

export function getIndexState(): IndexState {
  const entries = Array.from(stateByRepoId.values()).sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );
  const inFlight = entries.some((e) => e.status === 'pending' || e.status === 'indexing');
  return {
    bootRan,
    inFlight,
    entries,
  };
}

async function getCurrentHead(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    const head = stdout.trim();
    return head || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort repo size in bytes. We capped the recursion at
 * SIZE_WALK_ENTRY_CAP to avoid spending boot time enumerating huge trees;
 * past that cap we treat the repo as "definitely big" and defer it.
 *
 * Returns:
 *   - bytes when fully measured under the cap
 *   - null when measurement failed (treat as small/unknown — proceed)
 *   - Number.POSITIVE_INFINITY when we hit the cap (treat as oversize)
 */
function measureRepoSize(localPath: string): number | null {
  let total = 0;
  let entriesSeen = 0;
  const stack: string[] = [localPath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: ReturnType<typeof readdirSync>;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      entriesSeen += 1;
      if (entriesSeen > SIZE_WALK_ENTRY_CAP) {
        return Number.POSITIVE_INFINITY;
      }
      // Skip the usual giants — they exist in basically every repo.
      if (
        dirent.name === 'node_modules' ||
        dirent.name === '.git' ||
        dirent.name === 'target' ||
        dirent.name === '.next' ||
        dirent.name === 'dist'
      ) {
        // Approximate node_modules size by stating the directory once.
        try {
          const s = statSync(join(dir, dirent.name));
          total += s.size;
        } catch {
          /* ignore */
        }
        continue;
      }
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const s = statSync(full);
        total += s.size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

interface RunIndexJobOpts {
  binPath: string;
  repo: RepoRegistryEntry;
  maxSizeBytes: number;
}

async function runIndexJob({ binPath, repo, maxSizeBytes }: RunIndexJobOpts): Promise<void> {
  const repoId = repo.id;

  // Size guard. Defer oversize repos.
  let sizeBytes: number | null = null;
  try {
    sizeBytes = measureRepoSize(repo.localPath);
  } catch {
    sizeBytes = null;
  }
  if (sizeBytes !== null && sizeBytes !== Number.POSITIVE_INFINITY) {
    patchEntry(repoId, { sizeBytes });
  }
  if (sizeBytes !== null && sizeBytes > maxSizeBytes) {
    logInfo(`deferring ${repo.name}: size ${Math.round(sizeBytes / (1024 * 1024))} MB > limit`);
    patchEntry(repoId, {
      status: 'deferred' satisfies RepoIndexStatus,
      sizeBytes: sizeBytes === Number.POSITIVE_INFINITY ? null : sizeBytes,
    });
    return;
  }

  // HEAD-based cache check.
  const currentHead = await getCurrentHead(repo.localPath);
  if (!currentHead) {
    logWarn(`skipping ${repo.name}: not a git repo or HEAD unresolved`);
    patchEntry(repoId, { status: 'skipped' satisfies RepoIndexStatus });
    return;
  }
  const recordedHead = getRecordedHead(repoId);
  if (recordedHead && recordedHead === currentHead) {
    logInfo(`cached ${repo.name}: HEAD ${currentHead.slice(0, 7)} unchanged`);
    patchEntry(repoId, {
      status: 'cached' satisfies RepoIndexStatus,
      lastIndexedHead: currentHead,
    });
    return;
  }

  // Issue index_repository. cwd = repo root so the binary indexes the right tree.
  patchEntry(repoId, { status: 'indexing' satisfies RepoIndexStatus });
  logInfo(`indexing ${repo.name} (HEAD ${currentHead.slice(0, 7)})`);

  const result = await callCodebaseMemoryTool({
    binPath,
    cwd: repo.localPath,
    toolName: INDEX_TOOL_NAME,
    // #852: binary v0.6.0+ requires `repo_path`, not `path`. Passing the wrong
    // key returned `{ isError: true }` which the old mcp-client also dropped,
    // so the indexer marked every repo as cached without ever indexing.
    args: { repo_path: repo.localPath },
  });

  if (!result.ok) {
    logWarn(`index failed for ${repo.name}: ${result.error}`);
    patchEntry(repoId, {
      status: 'error' satisfies RepoIndexStatus,
      error: result.error,
      durationMs: result.durationMs,
    });
    return;
  }

  recordIndexedHead(repoId, currentHead);
  patchEntry(repoId, {
    status: 'ready' satisfies RepoIndexStatus,
    lastIndexedHead: currentHead,
    lastIndexedAt: new Date().toISOString(),
    error: null,
    durationMs: result.durationMs,
  });
  logInfo(`indexed ${repo.name} in ${result.durationMs}ms`);
}

/**
 * Drain the pending queue with bounded concurrency.
 *
 * Plain promise-pool. We don't pull in p-queue because the dep adds cost
 * and this is fewer than 50 lines.
 */
async function runWithConcurrency(
  jobs: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  const active = new Set<Promise<void>>();
  for (const job of jobs) {
    const run = job().catch((err: unknown) => {
      logWarn('indexer worker threw:', err);
    });
    active.add(run);
    void run.finally(() => active.delete(run));
    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);
}

export interface IndexAllOpts {
  /** Override max repo size. Defaults to 500 MB. */
  maxRepoSizeBytes?: number;
  /** Override concurrency. Defaults to 2. */
  concurrency?: number;
  /** Override the binary-wait deadline. */
  binaryWaitTimeoutMs?: number;
}

/**
 * Run a single boot pass. Idempotent — concurrent calls share state.
 * Resolves when every repo's index attempt has settled.
 */
export async function indexAllRepos(opts: IndexAllOpts = {}): Promise<IndexState> {
  if (bootInFlight) {
    return getIndexState();
  }
  bootInFlight = true;
  bootRan = true;

  const concurrency = opts.concurrency ?? DEFAULT_INDEX_CONCURRENCY;
  const maxSizeBytes = opts.maxRepoSizeBytes ?? DEFAULT_MAX_REPO_SIZE_BYTES;
  const waitMs = opts.binaryWaitTimeoutMs ?? BINARY_WAIT_TIMEOUT_MS;

  try {
    let repos: RepoRegistryEntry[];
    try {
      repos = await listRepos();
    } catch (err) {
      logWarn('failed to read repo registry:', err);
      return getIndexState();
    }

    if (repos.length === 0) {
      logInfo('no registered repos — boot pass is a no-op');
      return getIndexState();
    }

    // Initialize state for each repo so the status endpoint has something
    // to return immediately even before binary resolution.
    for (const repo of repos) {
      setEntry({
        repoId: repo.id,
        repoName: repo.name,
        localPath: repo.localPath,
        status: 'pending',
      });
    }

    // Resolve binary; wait for #739's download if necessary.
    let binPath = resolveCodebaseMemoryBin();
    if (!binPath) {
      logInfo('binary not yet available — waiting for #739 download');
      binPath = await waitForCodebaseMemoryBin(waitMs);
    }
    if (!binPath) {
      logWarn('binary unavailable after wait — marking all repos skipped');
      for (const repo of repos) {
        patchEntry(repo.id, {
          status: 'skipped' satisfies RepoIndexStatus,
          error: 'codebase-memory-mcp binary unavailable',
        });
      }
      return getIndexState();
    }

    logInfo(`boot pass: ${repos.length} repos, binary at ${binPath}`);

    const jobs: Array<() => Promise<void>> = repos.map(
      (repo) => () => runIndexJob({ binPath: binPath!, repo, maxSizeBytes }),
    );
    await runWithConcurrency(jobs, concurrency);

    const state = getIndexState();
    const ready = state.entries.filter((e) => e.status === 'ready').length;
    const cached = state.entries.filter((e) => e.status === 'cached').length;
    const deferred = state.entries.filter((e) => e.status === 'deferred').length;
    const errored = state.entries.filter((e) => e.status === 'error').length;
    logInfo(
      `boot pass complete: ${ready} indexed, ${cached} cached, ${deferred} deferred, ${errored} errored`,
    );
    return state;
  } finally {
    bootInFlight = false;
  }
}

let bootHookFired = false;

/**
 * Idempotent boot trigger. Call from any route that the Tauri shell hits
 * early (we use /api/panel/status). Spawns indexAllRepos on a microtask
 * so the route handler returns immediately.
 *
 * Mirrors the `ensureBooted()` pattern in src/lib/skeleton/autoscan.ts.
 */
export function ensureCodebaseMemoryBootIndex(): void {
  if (bootHookFired) return;
  bootHookFired = true;
  setImmediate(() => {
    void indexAllRepos().catch((err: unknown) => {
      logWarn('boot pass threw:', err);
    });
  });
}
