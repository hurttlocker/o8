import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('gh', args, {
    cwd,
    timeout: 15_000,
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
  });
  return stdout.trim();
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo');
  const number = searchParams.get('number');

  if (!repo || !number) {
    return NextResponse.json({ error: 'repo and number required' }, { status: 400 });
  }

  try {
    const raw = await gh([
      'pr', 'view', number,
      '--json', 'number,title,body,author,headRefName,baseRefName,state,mergeable,additions,deletions,changedFiles,statusCheckRollup,reviewDecision,files,url',
    ], repo);

    const data = JSON.parse(raw);

    const checksStatus = (() => {
      const checks = data.statusCheckRollup || [];
      if (checks.length === 0) return 'unknown';
      const failed = checks.some((c: { conclusion: string }) => c.conclusion === 'FAILURE');
      const pending = checks.some((c: { status: string }) => c.status !== 'COMPLETED');
      if (failed) return 'failure';
      if (pending) return 'pending';
      return 'success';
    })();

    return NextResponse.json({
      number: data.number,
      title: data.title,
      body: data.body || '',
      author: data.author?.login || 'unknown',
      branch: data.headRefName,
      baseBranch: data.baseRefName,
      state: data.state,
      mergeable: data.mergeable === 'MERGEABLE',
      additions: data.additions || 0,
      deletions: data.deletions || 0,
      changedFiles: data.changedFiles || 0,
      checksStatus,
      reviewDecision: data.reviewDecision || null,
      files: (data.files || []).map((f: { path: string; additions: number; deletions: number }) => ({
        path: f.path,
        status: f.additions > 0 && f.deletions === 0 ? 'added' :
                f.additions === 0 && f.deletions > 0 ? 'deleted' : 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
      })),
      url: data.url,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch PR' },
      { status: 500 },
    );
  }
}
