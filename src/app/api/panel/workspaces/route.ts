export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import os from 'node:os';
import path from 'node:path';
import { fetchGitHubPullRequestSummaries, normalizeRepoSlug } from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';

// PR data cache — shared across requests, per repo
const prCache = new Map<string, { prs: PRData[]; ts: number }>();
const PR_CACHE_TTL_MS = 60_000; // 60s — PRs change slowly

interface PRData {
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt?: string | null;
  url: string;
}

interface WorkspaceEntry {
  id: string;
  agentName: string;
  agentStatus: string;
  sessionKey: string;
  workspace: string;
  branch: string;
  repo: string;
  // Local diff stats (uncommitted + recent commits, used when no PR)
  localDiff?: { additions: number; deletions: number; changedFiles: number };
  // PR data (null if no matching PR)
  pr: {
    number: number;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    state: 'open' | 'merged' | 'closed';
    url: string;
  } | null;
  // Derived status
  status: 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled';
}

function deriveRepo(workspace: string): string {
  const path = workspace.replace(/^~\//, '');
  if (path.includes('/.cortex-worktrees/')) {
    const repoRoot = path.split('/.cortex-worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || '';
  }
  if (path.includes('/.claude/worktrees/')) {
    const repoRoot = path.split('/.claude/worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || '';
  }
  if (path.includes('repos/')) {
    const parts = path.split('repos/');
    return parts[1]?.split('/')[0] || '';
  }
  if (path.includes('projects/')) {
    const parts = path.split('projects/');
    return parts[1]?.split('/')[0] || '';
  }
  return '';
}

// Map OpenClaw agent session keys to the repos they actively work on
// This is how the agent cards show the correct repo's diff
function getAgentActiveRepo(sessionKey: string): { repo: string; path: string } | null {
  // Agent → repo mapping is auto-detected from the workspace root.
  // Falls back to process.cwd() when CORTEX_IDE_WORKSPACE_ROOT is not set.
  const workspaceRoot = process.env.CORTEX_IDE_WORKSPACE_ROOT || process.cwd();
  const map: Record<string, { repo: string; path: string }> = {
    'agent:main:main': { repo: path.basename(workspaceRoot), path: workspaceRoot },
  };
  return map[sessionKey] || null;
}

function resolveWorkspacePath(workspace: string): string {
  return workspace.replace(/^~/, process.env.HOME || os.homedir());
}

// Resolve current git branch for a path
const branchCache = new Map<string, { branch: string; ts: number }>();
const BRANCH_CACHE_TTL = 10_000;

function resolveGitBranch(repoPath: string): string {
  const now = Date.now();
  const cached = branchCache.get(repoPath);
  if (cached && now - cached.ts < BRANCH_CACHE_TTL) return cached.branch;

  try {
    const resolved = resolveWorkspacePath(repoPath);
    const branch = execSync(`git -C "${resolved}" branch --show-current 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim() || 'main';
    branchCache.set(repoPath, { branch, ts: now });
    return branch;
  } catch {
    return 'main';
  }
}

// Cache to avoid re-running git on every poll (30s TTL)
const diffCache = new Map<string, { data: { additions: number; deletions: number; changedFiles: number } | null; ts: number }>();
const DIFF_CACHE_TTL = 30_000;

function getLocalDiffStats(workspace: string): { additions: number; deletions: number; changedFiles: number } | null {
  try {
    const isDefault = workspace === 'unknown';
    const cwd = isDefault
      ? (process.env.CORTEX_IDE_WORKSPACE_ROOT || process.cwd())
      : resolveWorkspacePath(workspace);

    // Check cache
    const cached = diffCache.get(cwd);
    if (cached && Date.now() - cached.ts < DIFF_CACHE_TTL) return cached.data;

    // For agent workspaces (clawd): show only uncommitted changes
    // For code repos (cortex-ide etc): origin/main..HEAD + uncommitted (resets on push)
    const cmd = isDefault
      ? 'git diff --shortstat 2>/dev/null'
      : 'git diff --shortstat origin/main..HEAD 2>/dev/null; git diff --shortstat 2>/dev/null';
    const diffStat = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000 }).trim();

    let additions = 0, deletions = 0, changedFiles = 0;

    for (const line of diffStat.split('\n').filter(Boolean)) {
      const filesMatch = line.match(/(\d+) files? changed/);
      const addMatch = line.match(/(\d+) insertions?\(\+\)/);
      const delMatch = line.match(/(\d+) deletions?\(-\)/);
      if (filesMatch) changedFiles += parseInt(filesMatch[1]);
      if (addMatch) additions += parseInt(addMatch[1]);
      if (delMatch) deletions += parseInt(delMatch[1]);
    }

    const result = (additions === 0 && deletions === 0) ? null : { additions, deletions, changedFiles };
    diffCache.set(cwd, { data: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    // 1. Fetch agent sessions
    let sessions: Array<{
      name: string;
      status: string;
      sessionKey: string;
      workspace: string;
      branch: string;
    }> = [];

    try {
      const inboxRes = await fetch('http://localhost:3001/api/mobile/inbox', {
        signal: AbortSignal.timeout(8000),
      });
      if (inboxRes.ok) {
        const data = await inboxRes.json();
        sessions = (data.sessions || []).map((s: Record<string, unknown>) => ({
          name: (s.name as string) || '',
          status: (s.status as string) || 'idle',
          sessionKey: (s.sessionKey as string) || '',
          workspace: (s.workspace as string) || 'unknown',
          branch: (s.branch as string) || '',
        }));
      }
    } catch { /* silent */ }

    const registeredRepos = await listRepos().catch(() => []);
    const repoSlugByName = new Map<string, string>();
    for (const entry of registeredRepos) {
      const slug = normalizeRepoSlug(entry.remoteUrl);
      if (!slug) continue;
      repoSlugByName.set(entry.name, slug);
    }
    const fallbackSlugMap: Record<string, string> = {
      'cortex': 'hurttlocker/cortex',
      'parasite-network': 'hurttlocker/parasite-network',
      'spear-production': 'LavonTMCQ/spear-production',
      'mybeautifulwife': 'LavonTMCQ/mybeautifulwife',
    };

    // 2. Collect unique repos from sessions + agent active repos
    const repoSet = new Set<string>();
    for (const s of sessions) {
      const repo = deriveRepo(s.workspace);
      if (repo) repoSet.add(repo);
      const active = getAgentActiveRepo(s.sessionKey);
      if (active) repoSet.add(active.repo);
    }

    // 3. Fetch PRs for each repo
    const prsByBranch = new Map<string, PRData & { ghRepo: string }>();
    for (const repoName of repoSet) {
      const ghRepo = repoSlugByName.get(repoName) ?? fallbackSlugMap[repoName] ?? '';
      if (!ghRepo) continue;

      try {
        const cached = prCache.get(ghRepo);
        let prs: PRData[];
        if (cached && (Date.now() - cached.ts) < PR_CACHE_TTL_MS) {
          prs = cached.prs;
        } else {
          prs = await fetchGitHubPullRequestSummaries(ghRepo, {
            states: ['open', 'closed'],
            limitPerState: 20,
          }) as PRData[];
          prCache.set(ghRepo, { prs, ts: Date.now() });
        }
        for (const pr of prs) {
          prsByBranch.set(`${repoName}:${pr.headRefName}`, { ...pr, ghRepo });
        }
      } catch { /* silent — repo may not have PRs */ }
    }

    // 4. Build workspace entries — join sessions with PRs
    const workspaces: WorkspaceEntry[] = [];

    for (const s of sessions) {
      let repoName = deriveRepo(s.workspace);
      // OpenClaw agents report workspace=unknown but work in ~/clawd
      if (!repoName && s.workspace === 'unknown') {
        repoName = 'clawd';
      }
      if (!repoName) continue;

      // Resolve real git branch for OpenClaw agents with known repos
      let branchName = s.branch.replace(/^surface\//, '');
      const activeRepo = getAgentActiveRepo(s.sessionKey);
      // If agent has a known active repo, always resolve the real git branch
      // (OpenClaw surface branches like "current-q-chat", "discord-channel" aren't git branches)
      if (activeRepo) {
        branchName = resolveGitBranch(activeRepo.path);
      }
      const pr = prsByBranch.get(`${repoName}:${branchName}`) || null;

      // Derive status
      const isRunning = s.status === 'running' || s.status === 'watching' || s.status === 'healthy';
      let status: WorkspaceEntry['status'];
      if (pr?.mergedAt) {
        status = 'done';
      } else if (pr?.state.toLowerCase() === 'closed') {
        status = 'cancelled';
      } else if (pr?.state.toLowerCase() === 'open') {
        status = 'in_review';
      } else if (isRunning) {
        status = 'in_progress';
      } else {
        status = 'idle';
      }

      // For agents without a PR, get local diff stats
      // OpenClaw agents: use their active repo, not clawd workspace
      let diffWorkspace = s.workspace;
      if (activeRepo) {
        diffWorkspace = activeRepo.path;
        if (!repoName || repoName === 'clawd') repoName = activeRepo.repo;
      }
      const localDiff = (!pr && repoName !== 'clawd') ? getLocalDiffStats(diffWorkspace) : null;
      const ghRepo = repoSlugByName.get(repoName) ?? fallbackSlugMap[repoName] ?? '';
      // Activity classification removed — top timeline handles this

      workspaces.push({
        id: s.sessionKey || s.name,
        agentName: s.name,
        agentStatus: s.status,
        sessionKey: s.sessionKey,
        workspace: s.workspace,
        branch: branchName,
        repo: repoName,
        localDiff: localDiff ?? undefined,
        pr: pr ? {
          number: pr.number,
          title: pr.title,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          state: pr.mergedAt ? 'merged' : pr.state.toLowerCase() === 'closed' ? 'closed' : 'open',
          url: pr.url || `https://github.com/${ghRepo}/pull/${pr.number}`,
        } : null,
        status,
      });
    }

    return NextResponse.json({ workspaces, repos: Array.from(repoSet) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, workspaces: [], repos: [] }, { status: 200 });
  }
}
