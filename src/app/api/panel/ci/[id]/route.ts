export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_REPO = process.env.GITHUB_REPO || '';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo') || DEFAULT_REPO;
  const runId = parseInt(id, 10);

  if (isNaN(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 });
  }

  try {
    // Get run detail
    const detailJson = execSync(
      `gh run view ${runId} --repo ${repo} --json databaseId,displayTitle,event,headBranch,status,conclusion,createdAt,updatedAt,workflowName,url,jobs`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const detail = JSON.parse(detailJson);

    // Get logs (truncate to 30KB)
    let logs = '';
    try {
      logs = execSync(
        `gh run view ${runId} --repo ${repo} --log 2>&1 | head -500`,
        { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      if (logs.length > 30000) {
        logs = logs.slice(0, 30000) + '\n\n... (truncated at 30KB)';
      }
    } catch { /* logs may not be available */ }

    return NextResponse.json({ run: detail, logs, repo });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
