import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { stdout: userJson } = await exec('gh', ['api', 'user', '--jq', '.login'], {
      timeout: 10_000,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });

    let repos = 0;
    try {
      const { stdout: repoCount } = await exec('gh', ['repo', 'list', '--limit', '1', '--json', 'name', '--jq', 'length'], {
        timeout: 10_000,
        env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
      });
      repos = parseInt(repoCount.trim()) || 0;
    } catch { /* ignore */ }

    return NextResponse.json({
      authenticated: true,
      username: userJson.trim(),
      repos,
    });
  } catch {
    return NextResponse.json({
      authenticated: false,
      username: '',
      repos: 0,
    });
  }
}
