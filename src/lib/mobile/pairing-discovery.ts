/**
 * Public, nonce-bound discovery proof for an already enrolled mobile device.
 *
 * A phone can ask every port in the small o8 allocation blocks without sending
 * its device bearer. It only trusts a response signed by the server identity
 * that pairing pinned, then sends the bearer to the discovered canonical port.
 */

export const MOBILE_PAIRING_DISCOVERY_VERSION = 1 as const;

export interface MobilePairingDiscovery {
  v: typeof MOBILE_PAIRING_DISCOVERY_VERSION;
  nonce: string;
  apiPort: number;
  wsPort: number;
  signature: string;
}

export function pairingDiscoveryTranscript(
  nonce: string,
  apiPort: number,
  wsPort: number,
): string {
  return `o8-e2ee-v1|pairing-discovery|${nonce}|${apiPort}|${wsPort}`;
}

export function isPairingDiscoveryNonce(value: string | null): value is string {
  return value !== null
    && value.length >= 16
    && value.length <= 256
    && /^[A-Za-z0-9+/_=-]+$/.test(value);
}
