export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { withOptionalAuth } from '@/lib/auth/middleware';
import { getPersonalizedChatFtuxPayload } from '@/lib/llm/personalized-chat-ftux';

export const GET = withOptionalAuth(async (request, auth) => {
  const preferredRepoName = request.nextUrl.searchParams.get('repoName');
  const scopedRepoRoot = request.nextUrl.searchParams.get('repoPath');

  const payload = await getPersonalizedChatFtuxPayload({
    userName: auth?.user.name,
    preferredRepoName,
    scopedRepoRoot,
  });

  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
});
