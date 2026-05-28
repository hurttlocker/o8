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

interface MobilePairingResponse {
  /** Mac's Tailscale/LAN host — null when no reachable interface is found. */
  host: string | null;
  hostKind: ReachableMobileHostKind | null;
  apiPort: number;
  wsPort: number;
  token: string;
}

export async function GET() {
  try {
    const { apiPort, wsPort } = resolvePortInfo();
    const pairingHost = pickMobilePairingHost();
    const payload: MobilePairingResponse = {
      host: pairingHost.host,
      hostKind: pairingHost.kind,
      apiPort,
      wsPort,
      token: getOrCreateWsToken(),
    };
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build pairing payload' },
      { status: 500 },
    );
  }
}
