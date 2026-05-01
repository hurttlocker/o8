export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { probeBranchMerged } from '@/lib/orchestrator/branch-merge-probe';
import { requirePanelAuth } from '@/lib/panel/auth';

interface BranchMergedRequestBody {
  repoPath?: unknown;
  path?: unknown;
  branch?: unknown;
  base?: unknown;
}

function stringParam(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

async function respond(input: BranchMergedRequestBody) {
  const repoPath = stringParam(input.repoPath) || stringParam(input.path);
  const branch = stringParam(input.branch, 'HEAD') || 'HEAD';
  const base = stringParam(input.base, 'main') || 'main';

  if (!repoPath) {
    return NextResponse.json({ error: 'repoPath is required' }, { status: 400 });
  }

  try {
    const result = await probeBranchMerged({ repoPath, branch, base });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to probe branch merge state',
        merged: false,
        mergeCommit: null,
        ahead: 0,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  return respond({
    repoPath: request.nextUrl.searchParams.get('repoPath'),
    path: request.nextUrl.searchParams.get('path'),
    branch: request.nextUrl.searchParams.get('branch'),
    base: request.nextUrl.searchParams.get('base'),
  });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as BranchMergedRequestBody;
  return respond(body);
}
