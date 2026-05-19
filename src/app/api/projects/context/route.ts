import { NextResponse, type NextRequest } from 'next/server';

import {
  buildProjectTaskBrief,
  getProjectContext,
  type ProjectTaskBriefOptions,
} from '@/lib/projects/context';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

function optionsFromSearchParams(searchParams: URLSearchParams): ProjectTaskBriefOptions {
  return {
    repoPath: searchParams.get('repoPath') || searchParams.get('repo') || null,
    projectId: searchParams.get('projectId') || searchParams.get('project') || null,
    primaryRepoId: searchParams.get('primaryRepoId') || null,
    taskTitle: searchParams.get('taskTitle') || null,
    taskBody: searchParams.get('taskBody') || null,
  };
}

function optionsFromBody(body: unknown): ProjectTaskBriefOptions {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  const record = body as Record<string, unknown>;
  const readString = (key: string) => (typeof record[key] === 'string' ? record[key] as string : null);
  return {
    repoPath: readString('repoPath') ?? readString('repo'),
    projectId: readString('projectId') ?? readString('project'),
    primaryRepoId: readString('primaryRepoId'),
    taskTitle: readString('taskTitle'),
    taskBody: readString('taskBody'),
  };
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const options = optionsFromSearchParams(new URL(req.url).searchParams);
    const context = await getProjectContext(options);
    return NextResponse.json({
      context,
      taskBrief: buildProjectTaskBrief(context, options),
    }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve project context.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  try {
    const options = optionsFromBody(body);
    const context = await getProjectContext(options);
    return NextResponse.json({
      context,
      taskBrief: buildProjectTaskBrief(context, options),
    }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve project context.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}
