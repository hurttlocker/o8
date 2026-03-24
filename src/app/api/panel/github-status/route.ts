import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitHubBrokerStatus } from '@/lib/github-broker/status';

const exec = promisify(execFile);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readLocalGhStatus() {
  try {
    const { stdout: userJson } = await exec('gh', ['api', 'user', '--jq', '.login'], {
      timeout: 10_000,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });

    let repoCount = 0;
    try {
      const { stdout } = await exec('gh', ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner'], {
        timeout: 10_000,
        env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
      });
      const repos = JSON.parse(stdout || '[]') as Array<{ nameWithOwner: string }>;
      repoCount = repos.length;
    } catch {
      repoCount = 0;
    }

    return {
      authenticated: true,
      username: userJson.trim(),
      repos: repoCount,
    };
  } catch {
    return {
      authenticated: false,
      username: '',
      repos: 0,
    };
  }
}

export async function GET() {
  const [localGh, broker] = await Promise.all([
    readLocalGhStatus(),
    getGitHubBrokerStatus(),
  ]);

  return NextResponse.json({
    ...localGh,
    deviceFlowEnabled: Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim()),
    broker,
  });
}
