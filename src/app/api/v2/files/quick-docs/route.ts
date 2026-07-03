export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { homedir } from 'node:os';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { buildQuickDocs } from '@/lib/files/operator-config-docs';

async function resolveRoot(workspace?: string | null) {
  if (!workspace) return null;

  const requestedPath = workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

export async function GET(request: NextRequest) {
  let repoRoot: string | null = null;
  const workspace = request.nextUrl.searchParams.get('workspace');

  try {
    repoRoot = workspace ? await resolveRoot(workspace) : await getDefaultLlmRepoRoot();
  } catch {
    repoRoot = null;
  }

  return NextResponse.json(buildQuickDocs(repoRoot));
}
