/**
 * Mobile pairing payload — the data the desktop QR code encodes.
 *
 * The native o8 mobile app (hurttlocker/o8-mobile) can't inherit the backend
 * address the way the old PWA did — the phone loads nothing from the Mac. So
 * desktop emits a QR with everything the phone needs to reach this backend:
 *
 *   { host, apiPort, wsPort, token }
 *
 * `host` prefers the Mac's Tailscale IPv4 so the phone keeps working away from
 * local Wi-Fi, with LAN IPv4 as a fallback. `token` is the ws-token already
 * trusted by `src/middleware.ts` as a `Bearer` credential for non-loopback
 * callers — pairing only delivers it, the auth model is unchanged.
 *
 * Gated under `/api/panel/*` middleware: the desktop webview calls it from
 * loopback (passes automatically); a cross-origin caller would already need
 * the token to get here.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { pickMobilePairingHost, type ReachableMobileHostKind } from '@/lib/panel/lan-ip';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { mobileE2eeEnabled } from '@/lib/mobile/e2ee-flag';
import { createEnrollCode } from '@/lib/mobile/device-registry';
import { getServerIdentityPublicKey } from '@/lib/mobile/e2ee-identity';

interface MobilePairingResponse {
  /** Protocol version the phone reads to pick the enroll vs legacy-token path. */
  v: 1;
  /** Mac's Tailscale/LAN host — null when no reachable interface is found. */
  host: string | null;
  hostKind: ReachableMobileHostKind | null;
  apiPort: number;
  wsPort: number;
  /** Shared ws-token — kept during transition; a new (enroll-aware) app ignores it. */
  token: string;
  /** Single-use enroll code (E2EE mode only) — the phone POSTs it to /api/mobile/enroll. */
  enroll?: string;
  /** base64 server Ed25519 identity pub (E2EE mode only) — the phone pins it. */
  sIdent?: string;
}

export async function GET() {
  try {
    const { apiPort, wsPort } = resolvePortInfo();
    const pairingHost = pickMobilePairingHost();
    const payload: MobilePairingResponse = {
      v: 1,
      host: pairingHost.host,
      hostKind: pairingHost.kind,
      apiPort,
      wsPort,
      token: getOrCreateWsToken(),
    };
    // E2EE mode — additionally carry a one-time enroll code + the pinned server
    // identity. A new mobile app prefers these (per-device token + E2EE); an old
    // app falls back to `token`. Once every client is upgraded, drop `token`.
    if (mobileE2eeEnabled()) {
      payload.enroll = createEnrollCode(Date.now());
      payload.sIdent = getServerIdentityPublicKey();
    }
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build pairing payload' },
      { status: 500 },
    );
  }
}
