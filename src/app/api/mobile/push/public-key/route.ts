/**
 * GET /api/mobile/push/public-key
 *
 * Returns the VAPID public key so the mobile client can call
 * pushManager.subscribe({ applicationServerKey }). The public key is —
 * by definition — public, so this route is allow-listed in middleware.
 *
 * Issue: https://github.com/hurttlocker/o8/issues/639
 */

import { NextResponse } from 'next/server';
import { getVapidKeys } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const keys = getVapidKeys();
    return NextResponse.json(
      { publicKey: keys.publicKeyBase64Url },
      {
        headers: {
          'Cache-Control': 'private, max-age=600',
        },
      },
    );
  } catch (error) {
    console.error('[mobile/push/public-key] failed to load VAPID keys', error);
    return NextResponse.json(
      { error: 'Failed to load VAPID public key.' },
      { status: 500 },
    );
  }
}
