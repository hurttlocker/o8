/**
 * Mobile E2EE — feature flag.
 *
 * Gates the NEW pairing path: when ON, pairing hands out a one-time enroll code
 * + the server identity (per-device tokens + E2EE handshake); when OFF, pairing
 * returns the shared ws-token exactly as today. Per-device token *validation* is
 * always on (a no-op until a device enrolls), so toggling the flag never locks
 * out an already-enrolled device. Default OFF until the cross-side dogfood
 * (mirrors the #4/#6 playbook).
 */
export function mobileE2eeEnabled(): boolean {
  const raw = process.env.O8_MOBILE_E2EE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}
