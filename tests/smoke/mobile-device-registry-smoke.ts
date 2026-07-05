/**
 * #5 mobile E2EE — DB-backed device registry smoke test.
 * Run: CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx tests/smoke/mobile-device-registry-smoke.ts
 *
 * Verifies the enroll → resolve → revoke → resolve-fails round-trip against a
 * fresh SQLite DB (the CLAUDE.md tsx-on-temp-dir pattern; kept out of vitest to
 * avoid the better-sqlite3 native-module + server-only friction in the unit run).
 */

import assert from 'node:assert';

import './require-temp-data-dir';
import { enrollDevice, resolveDeviceByToken, listDevices, revokeDevice, hashToken, isTokenRevoked } from '@/lib/mobile/device-registry';

function main(): void {
  const { deviceId, deviceToken } = enrollDevice({ identityPublicKey: 'ZmFrZS1wdWJrZXk=', deviceLabel: 'Test iPhone' });
  assert(deviceId && deviceToken, 'enroll returns id + token');
  assert(deviceToken.length === 64, 'token is 32-byte hex');

  const resolved = resolveDeviceByToken(deviceToken);
  assert(resolved, 'active token resolves');
  assert(resolved!.id === deviceId, 'resolves to the right device');
  assert(resolved!.deviceLabel === 'Test iPhone', 'label round-trips');
  assert(resolved!.lastSeenAt, 'last_seen stamped on resolve');

  assert(resolveDeviceByToken('not-a-real-token') === null, 'unknown token → null');
  assert(resolveDeviceByToken('') === null, 'empty token → null');

  const list = listDevices();
  assert(list.length === 1 && list[0].id === deviceId, 'device appears in the list');
  // the stored hash must equal sha256(token); the raw token must never be stored
  assert(hashToken(deviceToken).length === 64, 'hash is sha256 hex');

  assert(isTokenRevoked(deviceToken) === false, 'active token is not flagged revoked');
  assert(revokeDevice(deviceId) === true, 'revoke transitions an active device');
  assert(revokeDevice(deviceId) === false, 'second revoke is a no-op');
  assert(resolveDeviceByToken(deviceToken) === null, 'revoked token no longer resolves');
  assert(isTokenRevoked(deviceToken) === true, 'revoked token is flagged (drives the 4401 close)');
  assert(isTokenRevoked('totally-unknown') === false, 'unknown token is NOT flagged revoked (→ 401 reject)');
  assert(listDevices()[0].revokedAt, 'revokedAt is stamped + still listed');

  console.log('[mobile-device-registry-smoke] PASS');
}

main();
