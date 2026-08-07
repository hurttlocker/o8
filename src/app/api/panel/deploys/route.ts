export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requirePanelAuth } from '@/lib/panel/auth';

const execFileAsync = promisify(execFile);

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo');

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format', deployments: [] }, { status: 400 });
  }

  try {
    // Get latest deployment statuses via GitHub API
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${repo}/deployments`,
      '--jq', '.[0:5] | map({name: .description, environment: .environment, sha: .sha, createdAt: .created_at, state: (if .statuses_url then "pending" else "unknown" end)})',
    ], { windowsHide: true, timeout: 15_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });

    const deployments = JSON.parse(stdout || '[]');

    // Enrich with actual status for each deployment
    const enriched = await Promise.all(
      deployments.map(async (d: { sha: string; environment: string; createdAt: string; name: string }) => {
        try {
          const { stdout: statusOut } = await execFileAsync('gh', [
            'api',
            `repos/${repo}/deployments?sha=${d.sha}&environment=${d.environment}`,
            '--jq', '.[0].statuses_url',
          ], { windowsHide: true, timeout: 8_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });

          if (statusOut.trim()) {
            const { stdout: stateOut } = await execFileAsync('gh', [
              'api', statusOut.trim(),
              '--jq', '.[0].state',
            ], { windowsHide: true, timeout: 8_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });
            return { ...d, state: stateOut.trim() || 'unknown' };
          }
        } catch {}
        return d;
      })
    );

    return NextResponse.json({ deployments: enriched, repo });
  } catch {
    // Fallback: try to get latest workflow runs as proxy for deploys
    try {
      const { stdout } = await execFileAsync('gh', [
        'run', 'list',
        '--repo', repo,
        '--limit', '5',
        '--json', 'name,status,conclusion,headSha,createdAt,event',
      ], { windowsHide: true, timeout: 15_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });

      const runs = JSON.parse(stdout || '[]');
      const deployments = runs.map((r: { name: string; status: string; conclusion: string; headSha: string; createdAt: string }) => ({
        name: r.name,
        environment: 'ci',
        sha: r.headSha,
        createdAt: r.createdAt,
        state: r.conclusion === 'success' ? 'success' : r.conclusion === 'failure' ? 'failure' : r.status === 'in_progress' ? 'in_progress' : 'pending',
      }));

      return NextResponse.json({ deployments, repo });
    } catch {
      return NextResponse.json({ deployments: [], repo });
    }
  }
}
