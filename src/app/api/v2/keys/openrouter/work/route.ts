export const dynamic = 'force-dynamic';

/**
 * GET /api/v2/keys/openrouter/work?days=30
 *
 * OpenRouter calls o8 itself made, from o8's own usage receipts (#3481). This
 * is a separate scope from the key figures in GET /api/v2/keys, which cover the
 * key everywhere, so the response never carries a combined total. Reading it
 * makes no OpenRouter request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { summarizeOpenRouterWork } from '@/lib/usage/openrouter-work';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const requested = Number(request.nextUrl.searchParams.get('days') ?? DEFAULT_DAYS);
  const days = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, MAX_DAYS) : DEFAULT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return NextResponse.json({ scope: 'o8-work', days, ...summarizeOpenRouterWork({ since }) });
}
