import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, _context: { params: Promise<{ number: string }> }) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json(
    { error: 'Creating a review workspace is temporarily unavailable.', code: 'review_workspace_unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
