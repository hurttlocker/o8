import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitHubBrokerStatus } from '@/lib/github-broker/status';
import { listRepos } from '@/lib/repos/registry';

const exec = promisify(execFile);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readLocalGhStatus() {
  try {
    const { stdout, stderr } = await exec('gh', ['auth', 'status', '--hostname', 'github.com'], {
      timeout: 10_000,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });
    const combined = `${stdout}\n${stderr}`.trim();
    const loginMatch = combined.match(/Logged in to github\.com account ([^\s]+)/i)
      ?? combined.match(/account ([^\s]+) \(/i);

    return {
      authenticated: true,
      username: loginMatch?.[1] ?? '',
      repos: 0,
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
  const [localGh, broker, registeredRepos] = await Promise.all([
    readLocalGhStatus(),
    getGitHubBrokerStatus(),
    listRepos().catch(() => []),
  ]);

  return NextResponse.json({
    ...localGh,
    repos: registeredRepos.filter((repo) => Boolean(repo.remoteUrl)).length,
    deviceFlowEnabled: Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim()),
    broker,
  });
}
