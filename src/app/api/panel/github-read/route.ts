import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { GitHubReadError, readGitHubRequest } from '@/lib/github-broker/read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function GET(request: NextRequest) {
  if (resolveRequestPrincipalContext(request).role !== 'operator') {
    return reply({ schema: 'o8/github-read/v1', ok: false, error: { code: 'github_read_operator_required' } }, 403);
  }
  try {
    return reply(await readGitHubRequest(new URL(request.url).searchParams));
  } catch (error) {
    return reply({ schema: 'o8/github-read/v1', ok: false, error: {
      code: error instanceof GitHubReadError ? error.code : 'github_app_read_unavailable',
    } }, error instanceof GitHubReadError ? error.status : 503);
  }
}
