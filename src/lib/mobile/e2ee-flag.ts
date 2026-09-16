/**
 * Mobile E2EE — feature flag.
 *
 * Gates the NEW pairing path: pairing hands out a one-time enroll code + the
 * server identity (per-device tokens + E2EE handshake). With it off, pairing
 * returns the shared ws-token instead. Per-device token *validation* is always
 * on (a no-op until a device enrolls), so toggling this never locks out an
 * already-enrolled device, and an existing legacy pairing keeps working either
 * way.
 *
 * Default ON since #2404. It was OFF pending the cross-side dogfood (#1298,
 * closed 2026-07-30) and the default was never flipped afterwards, so every
 * pairing made in the meantime was a legacy one. That costs more than
 * encryption: on the phone the pinned server identity is the only gate on relay
 * eligibility, and `recoverPairingConfig` refuses to probe for a moved port or
 * address without it — so a legacy pairing loses its desktop permanently the
 * first time either moves, with a QR re-scan as the only repair.
 *
 * `O8_MOBILE_E2EE` is now an explicit opt-OUT for anyone who needs the old
 * shared-token handout.
 */
export function mobileE2eeEnabled(): boolean {
  const raw = process.env.O8_MOBILE_E2EE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}
