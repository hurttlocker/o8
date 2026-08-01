/**
 * Paired-device list — the operator's "Paired devices"
 * surface. Gated like the rest of /api/mobile/* (loopback desktop passes; a
 * cross-origin caller needs the token). Returns device metadata only — never the
 * token or its hash.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { listDevices } from '@/lib/mobile/device-registry';

export async function GET(request: NextRequest) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ error: 'Paired-device administration is operator-only.' }, { status: 403 });
  }
  try {
    return NextResponse.json({ devices: listDevices() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list devices' },
      { status: 500 },
    );
  }
}
