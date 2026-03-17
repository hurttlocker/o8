export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

interface PRData {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt?: string;
}

interface WorkspaceEntry {
  id: string;
  agentName: string;
  agentStatus: string;
  sessionKey: string;
  workspace: string;
  branch: string;
  repo: string;
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

function ghOwnerRepo(repoName: string): string {
  // Map local repo dir names to GitHub owner/repo
  const map: Record<string, string> = {
    'cortex-ide': 'hurttlocker/cortex-ide',
    'cortex': 'hurttlocker/cortex',
    'parasite-network': 'hurttlocker/parasite-network',
    'spear-production': 'LavonTMCQ/spear-production',
    'mybeautifulwife': 'LavonTMCQ/mybeautifulwife',
  };
  return map[repoName] || '';
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

    // 2. Collect unique repos from sessions
    const repoSet = new Set<string>();
    for (const s of sessions) {
      const repo = deriveRepo(s.workspace);
      if (repo) repoSet.add(repo);
    }

    // 3. Fetch PRs for each repo
    const prsByBranch = new Map<string, PRData & { ghRepo: string }>();
    for (const repoName of repoSet) {
      const ghRepo = ghOwnerRepo(repoName);
      if (!ghRepo) continue;

      try {
        const openJson = execSync(
          `gh pr list --repo ${ghRepo} --state open --limit 20 --json number,title,state,author,headRefName,additions,deletions,changedFiles,createdAt`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        const mergedJson = execSync(
          `gh pr list --repo ${ghRepo} --state merged --limit 10 --json number,title,state,author,headRefName,additions,deletions,changedFiles,createdAt`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        const prs = [...JSON.parse(openJson), ...JSON.parse(mergedJson)] as PRData[];
        for (const pr of prs) {
          prsByBranch.set(`${repoName}:${pr.headRefName}`, { ...pr, ghRepo });
        }
      } catch { /* silent — repo may not have PRs */ }
    }

    // 4. Build workspace entries — join sessions with PRs
    const workspaces: WorkspaceEntry[] = [];

    for (const s of sessions) {
      const repoName = deriveRepo(s.workspace);
      if (!repoName) continue; // Skip non-repo sessions (OpenClaw agents, crons, etc.)

      // Try to match PR by branch
      const branchName = s.branch.replace('surface/', '');
      const pr = prsByBranch.get(`${repoName}:${branchName}`) || null;
      const ghRepo = ghOwnerRepo(repoName);

      // Derive status
      const isRunning = s.status === 'running' || s.status === 'watching' || s.status === 'healthy';
      let status: WorkspaceEntry['status'];
      if (pr?.state === 'MERGED') {
        status = 'done';
      } else if (pr?.state === 'CLOSED') {
        status = 'cancelled';
      } else if (pr?.state === 'OPEN') {
        status = 'in_review';
      } else if (isRunning) {
        status = 'in_progress';
      } else {
        status = 'idle';
      }

      workspaces.push({
        id: s.sessionKey || s.name,
        agentName: s.name,
        agentStatus: s.status,
        sessionKey: s.sessionKey,
        workspace: s.workspace,
        branch: branchName,
        repo: repoName,
        pr: pr ? {
          number: pr.number,
          title: pr.title,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
          url: `https://github.com/${ghRepo}/pull/${pr.number}`,
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
