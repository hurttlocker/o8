/**
 * Credential-free discovery for a paired phone whose saved API port moved.
 *
 * The response contains no bearer or enrollment material. Its signature binds
 * the caller nonce and current ports to the long-lived server identity that an
 * E2EE device already pinned, so a random listener cannot solicit the device
 * credential during the bounded recovery probe.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getServerIdentity } from '@/lib/mobile/e2ee-identity';
import { mobileE2eeEnabled } from '@/lib/mobile/e2ee-flag';
import {
  isPairingDiscoveryNonce,
  MOBILE_PAIRING_DISCOVERY_VERSION,
  pairingDiscoveryTranscript,
} from '@/lib/mobile/pairing-discovery';
import { signDetached } from '@/lib/mobile/e2ee-crypto';
import { resolvePortInfo } from '@/lib/panel/api-port';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!mobileE2eeEnabled()) {
    return NextResponse.json({ error: 'Mobile E2EE is not enabled.' }, { status: 404 });
  }

  const nonce = request.nextUrl.searchParams.get('nonce');
  if (!isPairingDiscoveryNonce(nonce)) {
    return NextResponse.json({ error: 'A valid discovery nonce is required.' }, { status: 400 });
  }

  const { apiPort, wsPort } = resolvePortInfo();
  const signature = signDetached(
    pairingDiscoveryTranscript(nonce, apiPort, wsPort),
    getServerIdentity().secretKey,
  );
  return NextResponse.json(
    { v: MOBILE_PAIRING_DISCOVERY_VERSION, nonce, apiPort, wsPort, signature },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
