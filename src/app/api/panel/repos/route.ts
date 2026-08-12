export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  addRepo,
  listRepos,
  touchRepo,
  updateRepo,
  validateRepo,
} from '@/lib/repos/registry';
import { cloneRepoToDefaultLocation, RepoCloneError } from '@/lib/repos/clone';
import { removeRepoPathFromProjects, repointRepoPathInProjects } from '@/lib/repos/project-path-mutations';
import { removeRepoFromPool } from '@/lib/repos/remove';
import { enrichRepoReadiness, enrichRepoReadinessList, invalidateRepoReadiness } from '@/lib/repos/readiness';
import { repointRepoPathReferences } from '@/lib/repos/path-repoint';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { isOrchestratorHomePath } from '@/lib/orchestrator/repo-path';
import { clearRepo as clearSkeletonCache } from '@/lib/skeleton/store';
import { triggerScan, triggerScanIfStale, startChangePolling, stopChangePolling } from '@/lib/skeleton/autoscan';
import { invalidateAnswerCache } from '@/lib/cortex/qa/ask';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { removeRuntimeTerminalSessionsForRepoPath, getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { killTmuxSession } from '@/lib/terminal/tmux';
import type {
  RepoRegistryDeleteBody,
  RepoRegistryPostBody,
} from '@/lib/repos/types';

const RUNTIME_CLEANUP_TIMEOUT_MS = 3_500;

async function pathExists(localPath: string) {
  try {
    await access(localPath);
    return true;
  } catch {
    return false;
  }
}

async function appendExistence<T extends { localPath: string }>(repo: T): Promise<T & { exists: boolean }> {
  return { ...repo, exists: await pathExists(repo.localPath) };
}

function normalizeScopePath(filePath?: string | null) {
  const trimmed = filePath?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^~(?=\/|$)/, process.env.HOME ?? '').replace(/\/+$/, '');
}

function pathBelongsToRepoScope(candidatePath?: string | null, repoPath?: string | null) {
  const candidate = normalizeScopePath(candidatePath);
  const repo = normalizeScopePath(repoPath);
  if (!candidate || !repo) return false;
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

function repoSlugFromRemote(remoteUrl?: string | null) {
  const normalized = remoteUrl?.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/') ?? '';
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

function agentBelongsToRepoScope(
  agent: {
    runtimeSurface?: { cwd?: string | null; reviewContext?: { repoSlug?: string | null } } | null;
    worktree?: { path?: string | null } | null;
    workspace?: string | null;
  },
  repo: { localPath: string; remoteUrl?: string | null; name: string },
) {
  const repoSlug = repoSlugFromRemote(repo.remoteUrl);
  if (repoSlug && agent.runtimeSurface?.reviewContext?.repoSlug === repoSlug) {
    return true;
  }

  const candidatePaths = [
    agent.worktree?.path,
    agent.runtimeSurface?.cwd,
    agent.workspace?.startsWith('/') ? agent.workspace : null,
  ];

  return candidatePaths.some((candidatePath) => pathBelongsToRepoScope(candidatePath, repo.localPath));
}

async function stopRepoBoundRuntimeSessions(repo: { localPath: string; remoteUrl?: string | null; name: string }) {
  const snapshot = await Promise.race([
    getRuntimeInventorySnapshot({ fresh: true }),
    new Promise<Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>>((_, reject) => {
      setTimeout(() => reject(new Error('Runtime inventory timed out.')), RUNTIME_CLEANUP_TIMEOUT_MS);
    }),
  ]).catch(() => null);
  if (!snapshot) {
    return {
      ok: false,
      targetedSessionCount: 0,
      stoppedSessionCount: 0,
      removedTerminalBindings: 0,
      note: 'Runtime inventory was unavailable; repository removal was not started.',
    };
  }
  const targetAgents = snapshot?.agents.filter((agent) => agentBelongsToRepoScope(agent, repo)) ?? [];
  const stoppedSessionKeys = new Set<string>();

  await Promise.all(targetAgents.map(async (agent) => {
    try {
      const result = await Promise.race([
        performRuntimeAction({
          action: 'stop',
          surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), RUNTIME_CLEANUP_TIMEOUT_MS);
        }),
      ]);
      if (result?.ok) stoppedSessionKeys.add(agent.sessionKey);
    } catch {
      return;
    }

    const terminalBinding = getRuntimeTerminalSession(agent.sessionKey);
    if (terminalBinding?.sessionName) {
      await Promise.race([
        killTmuxSession(terminalBinding.sessionName).catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, RUNTIME_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    }
  }));

  if (stoppedSessionKeys.size !== targetAgents.length) {
    return {
      ok: false,
      targetedSessionCount: targetAgents.length,
      stoppedSessionCount: stoppedSessionKeys.size,
      removedTerminalBindings: 0,
      note: 'One or more repo-bound runtime sessions could not be confirmed stopped.',
    };
  }

  const removedTerminalBindings = removeRuntimeTerminalSessionsForRepoPath(repo.localPath);

  return {
    ok: true,
    targetedSessionCount: targetAgents.length,
    stoppedSessionCount: stoppedSessionKeys.size,
    removedTerminalBindings: removedTerminalBindings.length,
  };
}

const execFileAsync = promisify(execFile);

/** List the authenticated user's GitHub repositories via the `gh` CLI — the
 *  app's GitHub auth source (see /api/panel/github-status, which reads
 *  `gh auth status`). Returns the raw GitHub API shape (full_name, clone_url,
 *  description, language, private, default_branch, …) that the onboarding repo
 *  picker (OnboardingReposStep) renders + clones from. Without this, the route
 *  fell through to the LOCAL registry (no `full_name`), so the picker rendered
 *  blank rows. */
async function listGithubRepos(limit: number): Promise<unknown[]> {
  const perPage = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  const { stdout } = await execFileAsync(
    'gh',
    ['api', `/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`],
    { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } },
  );
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

export async function GET(request: Request) {
  const startedAt = performance.now();
  const params = new URL(request.url).searchParams;

  // Onboarding repo picker asks for the user's GitHub repos (source=github);
  // everything else wants the local repo registry.
  if (params.get('source') === 'github') {
    try {
      const repos = await listGithubRepos(Number(params.get('limit')) || 50);
      return NextResponse.json({ repos }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
    } catch (error) {
      console.error('[repos] github list failed', error);
      return NextResponse.json(
        { error: 'Couldn’t list your GitHub repositories. Make sure GitHub is connected on this machine, then retry.' },
        { status: 502, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
      );
    }
  }

  try {
    const repos = await enrichRepoReadinessList(await listRepos());
    return NextResponse.json({ repos: await Promise.all(repos.map(appendExistence)) }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load repository registry.' },
      { status: 500, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
    );
  }
}

export async function POST(request: Request) {
  let body: RepoRegistryPostBody;
  try {
    body = (await request.json()) as RepoRegistryPostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const action = body.action ?? 'add';

    switch (action) {
      case 'validate': {
        if (!('localPath' in body) || !body.localPath?.trim()) {
          return NextResponse.json({ error: 'localPath is required.' }, { status: 400 });
        }
        const repo = await enrichRepoReadiness(await validateRepo(body.localPath));
        return NextResponse.json({ repo });
      }
      case 'add': {
        if (!('localPath' in body) || !body.localPath?.trim()) {
          return NextResponse.json({ error: 'localPath is required.' }, { status: 400 });
        }
        if (isOrchestratorHomePath(body.localPath)) {
          return NextResponse.json({ error: 'Home mode is not a registered repository.' }, { status: 400 });
        }
        const repo = await enrichRepoReadiness(await addRepo(body.localPath));
        // Auto-scan skeleton for newly added repo + start change polling
        triggerScan(repo.localPath);
        startChangePolling(repo.localPath);
        return NextResponse.json({ repo }, { status: 201 });
      }
      case 'clone': {
        // #1339 — onboarding GitHub selections used to POST { cloneUrl } into a
        // handler with no clone case (400 localPath required, swallowed client-side).
        if (!('cloneUrl' in body) || !body.cloneUrl?.trim()) {
          return NextResponse.json({ error: 'cloneUrl is required.' }, { status: 400 });
        }
        try {
          const { localPath } = await cloneRepoToDefaultLocation(body.cloneUrl, 'name' in body ? body.name : undefined);
          const repo = await enrichRepoReadiness(await addRepo(localPath));
          triggerScan(repo.localPath);
          startChangePolling(repo.localPath);
          return NextResponse.json({ repo }, { status: 201 });
        } catch (error) {
          if (error instanceof RepoCloneError) {
            return NextResponse.json({ error: error.message }, { status: error.statusCode });
          }
          throw error;
        }
      }
      case 'update': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        if ('localPath' in body && body.localPath !== undefined && (typeof body.localPath !== 'string' || !body.localPath.trim())) {
          return NextResponse.json({ error: 'localPath must be a Git repository folder.' }, { status: 400 });
        }
        if ('localPath' in body && body.localPath !== undefined) {
          if (isOrchestratorHomePath(body.localPath)) {
            return NextResponse.json({ error: 'Home mode is not a registered repository.' }, { status: 400 });
          }
          try {
            assertOrchestratorRepoPath(body.localPath);
          } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid repository folder.' }, { status: 400 });
          }
        }
        const previous = (await listRepos()).find((repo) => repo.id === body.id);
        const repo = await updateRepo(body.id, {
          localPath: 'localPath' in body ? body.localPath : undefined,
          setup: 'setup' in body ? body.setup : undefined,
          lastOpenedAt: 'lastOpenedAt' in body ? body.lastOpenedAt : undefined,
        });
        if (previous && previous.localPath !== repo.localPath) {
          await repointRepoPathInProjects(previous.localPath, repo.localPath);
          repointRepoPathReferences(previous.localPath, repo.localPath);
          invalidateRepoReadiness(previous.localPath, repo.localPath);
          invalidateAnswerCache();
          clearSkeletonCache(previous.localPath);
          stopChangePolling(previous.localPath);
          triggerScan(repo.localPath);
          startChangePolling(repo.localPath);
        }
        return NextResponse.json({ repo: await enrichRepoReadiness(repo) });
      }
      case 'touch': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        const repo = await touchRepo(
          body.id,
          'lastOpenedAt' in body ? body.lastOpenedAt ?? undefined : undefined,
        );
        // Rescan skeleton if stale when repo is opened
        triggerScanIfStale(repo.localPath);
        return NextResponse.json({ repo: await enrichRepoReadiness(repo) });
      }
      default:
        return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update repository registry.' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  let body: RepoRegistryDeleteBody;
  try {
    body = (await request.json()) as RepoRegistryDeleteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: 'id is required.' }, { status: 400 });
  }

  try {
    // Look up localPath before removal so the realtime note + runtime cleanup
    // below can reference the repo record.
    const repos = await listRepos();
    const toRemove = repos.find(r => r.id === body.id);

    const cleanup = toRemove
      ? await stopRepoBoundRuntimeSessions(toRemove)
      : {
          ok: true,
          targetedSessionCount: 0,
          stoppedSessionCount: 0,
          removedTerminalBindings: 0,
          note: 'No registered repository was found.',
        };
    if (!cleanup.ok) {
      return NextResponse.json({
        ok: false,
        error: 'repo_runtime_stop_unconfirmed',
        note: cleanup.note,
        stoppedSessions: cleanup,
      }, { status: 409 });
    }

    // Registry + SQLite links + lifecycle + terminal state + skeleton cache +
    // polling all go through the shared removal flow (also used by project
    // deletion). Ledger cleanup stays here.
    const removed = await removeRepoFromPool(body.id);
    if (toRemove?.localPath) {
      await removeRepoPathFromProjects(toRemove.localPath);
    }

    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `repo-remove-${body.id}-${Date.now()}`,
        source: 'desktop',
        action: 'stop',
        runtime: 'repo-registry',
        surfaceId: body.id,
        sessionKey: toRemove?.localPath,
        status: 'completed',
        note: toRemove
          ? `Stopped ${cleanup.stoppedSessionCount} repo-bound runtime session(s) and removed ${toRemove.name} from Cortex.`
          : 'Repository removed from Cortex.',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
      fresh: true,
    });

    return NextResponse.json({
      ok: true,
      removedId: body.id,
      stoppedSessions: {
        targetedSessionCount: cleanup.targetedSessionCount,
        stoppedSessionCount: cleanup.stoppedSessionCount,
        removedTerminalBindings: removed.removedTerminalBindings + cleanup.removedTerminalBindings,
        cleanupPending: false,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to remove repository.' },
      { status: 500 },
    );
  }
}
