/**
 * GET /api/team/presence — live `o8 team` peers across the operator's repos.
 *
 * The peer agents driving o8 (the top-level Claude Code / Codex sessions) register
 * presence as plain files under each repo's git common dir (`.git/agents/presence/`,
 * written by the `o8 team` CLI). This route aggregates the LIVE ones so Symon can
 * be peer-aware — name who else is driving alongside ("Atlas and Nova are both
 * working o8"). Read-only filesystem; the handle IS the canonical codename, so it
 * matches what Symon already speaks for dispatched agents.
 */

export const dynamic = 'force-dynamic';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { NextResponse } from 'next/server';
import { listRepos } from '@/lib/repos/registry';

const LIVE_TTL_MS = 6 * 60 * 1000;

interface Peer {
  codename: string;
  status: string;
  runtime: string;
  repo: string;
  repoPath: string;
  lastSeen: string;
}

export async function GET() {
  const peers: Peer[] = [];
  let repos: Array<{ name: string; localPath: string }> = [];
  try {
    repos = await listRepos();
  } catch {
    return NextResponse.json({ schema: 'o8/team.presence/v1', peers });
  }

  for (const repo of repos) {
    if (!repo?.localPath) continue;
    // Main worktrees keep their room at <repo>/.git/agents/presence (the CLI uses
    // `git rev-parse --absolute-git-dir`, which is <repo>/.git for a main tree).
    const presenceDir = path.join(repo.localPath, '.git', 'agents', 'presence');
    if (!existsSync(presenceDir)) continue;
    let files: string[];
    try {
      files = readdirSync(presenceDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const p = JSON.parse(readFileSync(path.join(presenceDir, file), 'utf8')) as {
          handle?: string; status?: string; runtime?: string; lastSeen?: string;
        };
        const seen = p.lastSeen ? Date.parse(p.lastSeen) : NaN;
        if (!Number.isFinite(seen) || Date.now() - seen > LIVE_TTL_MS) continue;
        peers.push({
          codename: p.handle ?? '',
          status: p.status ?? 'working',
          runtime: p.runtime ?? '',
          repo: repo.name,
          repoPath: repo.localPath,
          lastSeen: p.lastSeen ?? '',
        });
      } catch {
        /* skip a malformed presence file */
      }
    }
  }

  return NextResponse.json({ schema: 'o8/team.presence/v1', peers });
}
