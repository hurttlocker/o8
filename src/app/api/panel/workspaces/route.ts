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
  // Activity breakdown (for timeline bar)
  activity?: { coding: number; thinking: number; testing: number; idle: number };
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

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function getSessionActivity(sessionKey: string): { coding: number; thinking: number; testing: number; idle: number } | null {
  try {
    // Find JSONL for this session
    const HOME = process.env.HOME || '/Users/marquisehurtt';
    const agentsDir = join(HOME, '.openclaw/agents');
    
    // Extract session ID from key
    const sessionId = sessionKey.replace(/^(codex:|claude-code:|agent:\w+:)/, '');
    
    // Search for JSONL file
    const searchDirs = ['main', 'ace', 'hawk'];
    let jsonlPath = '';
    for (const agent of searchDirs) {
      const p = join(agentsDir, agent, 'sessions', `${sessionId}.jsonl`);
      if (existsSync(p)) { jsonlPath = p; break; }
    }
    
    // For Claude Code, check ~/.claude/projects/
    if (!jsonlPath && sessionKey.startsWith('claude-code:')) {
      const claudeId = sessionKey.replace('claude-code:', '');
      const claudeProjects = join(HOME, '.claude/projects');
      try {
        const dirs = require('fs').readdirSync(claudeProjects);
        for (const dir of dirs) {
          const p = join(claudeProjects, dir, `${claudeId}.jsonl`);
          if (existsSync(p)) { jsonlPath = p; break; }
        }
      } catch { /* silent */ }
    }
    
    if (!jsonlPath) return null;
    
    // Read last 200 lines for quick classification
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean).slice(-200);
    
    let coding = 0, thinking = 0, testing = 0, idle = 0;
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const type = d.type || d.message?.role;
        const text = typeof d.message?.content === 'string' ? d.message.content : '';
        
        if (type === 'toolResult' || type === 'tool' || (type === 'assistant' && text.length < 100 && d.message?.tool_calls)) {
          coding++;
        } else if (type === 'assistant' && text.length > 150) {
          thinking++;
        } else if (type === 'assistant' && /test|spec|assert|expect/.test(text.toLowerCase())) {
          testing++;
        } else {
          idle++;
        }
      } catch { idle++; }
    }
    
    const total = coding + thinking + testing + idle || 1;
    return {
      coding: Math.round(coding / total * 100),
      thinking: Math.round(thinking / total * 100),
      testing: Math.round(testing / total * 100),
      idle: Math.round(idle / total * 100),
    };
  } catch {
    return null;
  }
}

function resolveWorkspacePath(workspace: string): string {
  return workspace.replace(/^~/, process.env.HOME || '/Users/marquisehurtt');
}

function getLocalDiffStats(workspace: string): { additions: number; deletions: number; changedFiles: number } | null {
  try {
    const cwd = resolveWorkspacePath(workspace);
    // Uncommitted changes (working tree + staged)
    const diffStat = execSync('git diff --shortstat HEAD 2>/dev/null || true', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
    // Recent commits in last 6 hours
    const logStat = execSync('git log --since="6 hours ago" --shortstat --format="" 2>/dev/null || true', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();

    let additions = 0, deletions = 0, changedFiles = 0;

    const parseStat = (line: string) => {
      const filesMatch = line.match(/(\d+) files? changed/);
      const addMatch = line.match(/(\d+) insertions?\(\+\)/);
      const delMatch = line.match(/(\d+) deletions?\(-\)/);
      if (filesMatch) changedFiles += parseInt(filesMatch[1]);
      if (addMatch) additions += parseInt(addMatch[1]);
      if (delMatch) deletions += parseInt(delMatch[1]);
    };

    if (diffStat) parseStat(diffStat);
    for (const line of logStat.split('\n').filter(Boolean)) {
      parseStat(line);
    }

    if (additions === 0 && deletions === 0) return null;
    return { additions, deletions, changedFiles };
  } catch {
    return null;
  }
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

      // For agents without a PR, get local diff stats
      const localDiff = !pr ? getLocalDiffStats(s.workspace) : null;
      const activity = getSessionActivity(s.sessionKey) ?? undefined;

      workspaces.push({
        id: s.sessionKey || s.name,
        agentName: s.name,
        agentStatus: s.status,
        sessionKey: s.sessionKey,
        workspace: s.workspace,
        branch: branchName,
        repo: repoName,
        localDiff: localDiff ?? undefined,
        activity,
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
