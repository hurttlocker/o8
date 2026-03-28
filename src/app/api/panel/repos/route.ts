export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  addRepo,
  listRepos,
  removeRepo,
  touchRepo,
  updateRepo,
  validateRepo,
} from '@/lib/repos/registry';
import { enrichRepoReadiness, enrichRepoReadinessList } from '@/lib/repos/readiness';
import { triggerScan, triggerScanIfStale, startChangePolling, stopChangePolling } from '@/lib/skeleton/autoscan';
import { clearRepo as clearSkeletonCache } from '@/lib/skeleton/store';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/openclaw';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { removeRuntimeTerminalSessionsForRepoPath, getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { pruneTerminalStateForRepoPath } from '@/lib/terminal/state-store';
import { killTmuxSession } from '@/lib/terminal/tmux';
import { removeWorkspaceLifecycleRecordsForRepoPath } from '@/lib/workspace/lifecycle';
import type {
  RepoRegistryDeleteBody,
  RepoRegistryPostBody,
} from '@/lib/repos/types';

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
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true, includeOpenClaw: true });
  const targetAgents = snapshot.agents.filter((agent) => agentBelongsToRepoScope(agent, repo));
  const stoppedSessionKeys = new Set<string>();

  await Promise.allSettled(targetAgents.map(async (agent) => {
    try {
      await performRuntimeAction({
        action: 'stop',
        surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
      });
      stoppedSessionKeys.add(agent.sessionKey);
    } catch {
      // Best effort: repo removal should still proceed.
    }

    const terminalBinding = getRuntimeTerminalSession(agent.sessionKey);
    if (terminalBinding?.sessionName) {
      await killTmuxSession(terminalBinding.sessionName).catch(() => undefined);
    }
  }));

  const removedTerminalBindings = removeRuntimeTerminalSessionsForRepoPath(repo.localPath);

  return {
    targetedSessionCount: targetAgents.length,
    stoppedSessionCount: stoppedSessionKeys.size,
    removedTerminalBindings: removedTerminalBindings.length,
  };
}

export async function GET() {
  try {
    const repos = await enrichRepoReadinessList(await listRepos());
    return NextResponse.json({ repos });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load repository registry.' },
      { status: 500 },
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
        const repo = await enrichRepoReadiness(await addRepo(body.localPath));
        // Auto-scan skeleton for newly added repo + start change polling
        triggerScan(repo.localPath);
        startChangePolling(repo.localPath);
        return NextResponse.json({ repo }, { status: 201 });
      }
      case 'update': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        const repo = await updateRepo(body.id, {
          setup: 'setup' in body ? body.setup : undefined,
          lastOpenedAt: 'lastOpenedAt' in body ? body.lastOpenedAt : undefined,
        });
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
    // Look up localPath before removal so we can clean up skeleton cache
    const repos = await listRepos();
    const toRemove = repos.find(r => r.id === body.id);
    const stoppedSessions = toRemove
      ? await stopRepoBoundRuntimeSessions(toRemove)
      : { targetedSessionCount: 0, stoppedSessionCount: 0, removedTerminalBindings: 0 };

    await removeRepo(body.id);

    // Clean up skeleton/chunk cache + stop polling for this repo
    if (toRemove?.localPath) {
      removeWorkspaceLifecycleRecordsForRepoPath(toRemove.localPath);
      pruneTerminalStateForRepoPath(toRemove.localPath);
      clearSkeletonCache(toRemove.localPath);
      stopChangePolling(toRemove.localPath);
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
          ? `Removed ${toRemove.name} from Cortex and stopped ${stoppedSessions.stoppedSessionCount}/${stoppedSessions.targetedSessionCount} repo-bound runtime session(s).`
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
      stoppedSessions,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to remove repository.' },
      { status: 500 },
    );
  }
}
