import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitHubBrokerStatus } from '@/lib/github-broker/status';
import { listRepos } from '@/lib/repos/registry';

const exec = promisify(execFile);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stringFromExecChunk(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf-8');
  return '';
}

function parseGhStatusOutput(output: string) {
  const activeMatch = output.match(/Logged in to github\.com account ([^\s]+)[\s\S]*?Active account:\s*true/i);
  if (activeMatch?.[1]) {
    return {
      authenticated: true,
      username: activeMatch[1],
      repos: 0,
    };
  }

  const anyLoggedInMatch = output.match(/Logged in to github\.com account ([^\s]+)/i)
    ?? output.match(/account ([^\s]+) \(/i);

  if (anyLoggedInMatch?.[1]) {
    return {
      authenticated: true,
      username: anyLoggedInMatch[1],
      repos: 0,
    };
  }

  return {
    authenticated: false,
    username: '',
    repos: 0,
  };
}

async function readLocalGhStatus() {
  try {
    const { stdout, stderr } = await exec('gh', ['auth', 'status', '--hostname', 'github.com'], {
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });
    return parseGhStatusOutput(`${stdout}\n${stderr}`.trim());
  } catch (error) {
    const combined = `${stringFromExecChunk((error as { stdout?: unknown }).stdout)}\n${stringFromExecChunk((error as { stderr?: unknown }).stderr)}`.trim();
    return parseGhStatusOutput(combined);
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
