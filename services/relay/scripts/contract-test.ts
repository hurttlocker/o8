/**
 * CONTRACT TEST — self-contained unit asserts for the relay's pure logic.
 *
 * Mirrors services/license-server/scripts/contract-test.ts: no env, no DB, no
 * network. Covers the invariants the wire contract depends on:
 *   - plan-JWT verify (real EdDSA) + the 4409 rejection surface + entitlement map
 *   - routing table (supersede, device add/remove/count)
 *   - rate limits (≤30/min, ≤8 pending)
 *   - mux integrity — bytes in = bytes out untouched
 *   - close-code namespaces (4401/4403 Mac-origin vs 4408/4409 relay-origin)
 *
 * Run:  npm run contract-test   (or: tsx scripts/contract-test.ts)
 */
import { generateKeyPairSync } from 'node:crypto';

import { SignJWT, importPKCS8 } from 'jose';

import { isPlan, relayOffNetwork, type Plan } from '../src/entitlement.js';
import { verifyPlanTokenWith } from '../src/plan-jwt.js';
import { RoutingTable, RateLimiter, DEFAULT_RATE_LIMITS, type DeviceEntry } from '../src/routing.js';
import { CLOSE, isMacOriginCloseCode, toPayload, fromPayload, encode, decode, isMuxFrame } from '../src/protocol.js';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    failures += 1;
  }
}

const ISSUER = 'o8-license';

async function mint(privatePem: string, claims: Record<string, unknown>, expOffsetSec = 3600): Promise<string> {
  const key = await importPKCS8(privatePem, 'EdDSA');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setSubject('user_test_1')
    .setIssuedAt(now)
    .setExpirationTime(now + expOffsetSec)
    .sign(key);
}

async function testPlanJwt(): Promise<void> {
  console.log('\n[1] plan-JWT verify + entitlement (the 4409 surface)');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const opts = { publicKeyPem: pub, issuer: ISSUER };

  const founderTok = await mint(priv, { plan: 'founder' });
  const good = await verifyPlanTokenWith(founderTok, opts);
  assert(good.ok && good.plan === 'founder', 'valid founder token verifies');
  assert(good.ok && relayOffNetwork(good.plan), 'founder is relay-entitled (→ true)');

  const freeTok = await mint(priv, { plan: 'free' });
  const free = await verifyPlanTokenWith(freeTok, opts);
  assert(free.ok && free.plan === 'free', 'valid free token verifies');
  assert(free.ok && !relayOffNetwork(free.plan), 'free is NOT relay-entitled (→ 4409)');

  for (const p of ['pro', 'team', 'founder'] as Plan[]) {
    assert(relayOffNetwork(p), `paid tier '${p}' is relay-entitled (future-paid true at launch)`);
  }

  // Wrong key → reject.
  const { privateKey: otherPriv } = generateKeyPairSync('ed25519');
  const otherPem = otherPriv.export({ type: 'pkcs8', format: 'pem' }).toString();
  const wrongKeyTok = await mint(otherPem, { plan: 'founder' });
  const wrong = await verifyPlanTokenWith(wrongKeyTok, opts);
  assert(!wrong.ok, 'wrong-key token is rejected (signature check)');

  // Expired → reject.
  const expiredTok = await mint(priv, { plan: 'founder' }, -10);
  const expired = await verifyPlanTokenWith(expiredTok, opts);
  assert(!expired.ok && expired.reason === 'expired', 'expired token is rejected');

  // Wrong issuer → reject.
  const wrongIss = await verifyPlanTokenWith(founderTok, { publicKeyPem: pub, issuer: 'someone-else' });
  assert(!wrongIss.ok, 'wrong-issuer token is rejected');

  // Garbage → reject, never throws.
  const garbage = await verifyPlanTokenWith('not-a-jwt', opts);
  assert(!garbage.ok, 'garbage token is rejected (no throw)');

  assert(isPlan('founder') && !isPlan('enterprise'), 'isPlan guards the plan set');
}

function testRouting(): void {
  console.log('\n[2] routing table — supersede + device tracking');
  const rt = new RoutingTable<string>();
  const now = Date.now();

  const s1 = rt.registerMac('r1', 'macA', now);
  assert(s1 === null, 'first Mac registration supersedes nothing');
  const s2 = rt.registerMac('r1', 'macB', now + 1);
  assert(s2 === 'macA', 'second Mac registration supersedes the first (returns old)');
  assert(rt.getMac('r1') === 'macB', 'newest Mac wins');

  // A superseded socket closing late must not evict the newer one.
  assert(rt.removeMac('r1', 'macA') === false, 'superseded socket removeMac is a no-op');
  assert(rt.getMac('r1') === 'macB', 'newer Mac survives the stale close');
  assert(rt.removeMac('r1', 'macB') === true, 'current socket removeMac evicts');
  assert(rt.getMac('r1') === null, 'routingId cleared after current Mac removed');

  const mk = (sid: string): DeviceEntry<string> => ({ sid, socket: `sock-${sid}`, admittedAt: now, lastActivityAt: now, ready: false });
  rt.addDevice('r1', mk('a'));
  rt.addDevice('r1', mk('b'));
  assert(rt.devicesFor('r1').length === 2, 'two devices tracked');
  assert(rt.readyDeviceCount('r1') === 0, 'no ready devices yet');
  const dev = rt.getDevice('r1', 'a');
  if (dev) dev.ready = true;
  assert(rt.readyDeviceCount('r1') === 1, 'readyDeviceCount counts only ready');
  assert(rt.removeDevice('r1', 'a')?.sid === 'a', 'removeDevice returns the entry');
  assert(rt.devicesFor('r1').length === 1, 'one device left after remove');
}

function testRateLimits(): void {
  console.log('\n[3] rate limits — ≤30/min connects, ≤8 pending');
  const rl = new RateLimiter(DEFAULT_RATE_LIMITS);
  const t0 = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 35; i++) if (rl.allowConnect('r1', t0 + i)) allowed += 1;
  assert(allowed === DEFAULT_RATE_LIMITS.maxPerMin, `exactly ${DEFAULT_RATE_LIMITS.maxPerMin} connects allowed inside the window`);
  // After the window slides, connects flow again.
  assert(rl.allowConnect('r1', t0 + 61_000), 'connect allowed again after the 60s window slides');
  // Different routingId is independent.
  assert(rl.allowConnect('r2', t0 + 5), 'a different routingId is not rate-limited');

  const rotating = new RateLimiter({
    ...DEFAULT_RATE_LIMITS,
    maxPerIpPerMin: 4,
    maxGlobalPerMin: 100,
  });
  let rotatingAllowed = 0;
  for (let i = 0; i < 8; i++) {
    if (rotating.allowConnect(`rotated-${i}`, t0 + i, '203.0.113.10')) rotatingAllowed += 1;
  }
  assert(rotatingAllowed === 4, 'rotating routing ids cannot bypass the source-IP limit');

  const flood = new RateLimiter(DEFAULT_RATE_LIMITS);
  for (let i = 0; i < 20_000; i++) {
    flood.allowConnect('flood-route', t0, '203.0.113.20');
  }
  const floodWindows = (flood as unknown as {
    connects: Map<string, number[]>;
  }).connects;
  assert(
    floodWindows.get('route:flood-route')?.length === DEFAULT_RATE_LIMITS.maxPerMin,
    'blocked route flood state stays bounded at the route limit',
  );
  assert(
    floodWindows.get('ip:203.0.113.20')?.length === DEFAULT_RATE_LIMITS.maxPerIpPerMin,
    'blocked route flood state stays bounded at the source-IP limit',
  );
  assert(
    floodWindows.get('global')?.length === DEFAULT_RATE_LIMITS.maxGlobalPerMin,
    'blocked route flood state stays bounded at the global limit',
  );

  const rl2 = new RateLimiter(DEFAULT_RATE_LIMITS);
  let pending = 0;
  for (let i = 0; i < 12; i++) if (rl2.admitPending('r1')) pending += 1;
  assert(pending === DEFAULT_RATE_LIMITS.maxPending, `exactly ${DEFAULT_RATE_LIMITS.maxPending} pending sockets admitted`);
  rl2.clearPending('r1');
  assert(rl2.admitPending('r1'), 'clearing a pending slot admits one more');
}

function testMuxIntegrity(): void {
  console.log('\n[4] mux integrity — bytes in = bytes out untouched');
  // Random opaque bytes incl. an {e2ee,n,c}-shaped inner frame.
  const cases: Uint8Array[] = [
    new Uint8Array([0, 1, 2, 255, 254, 128, 127]),
    new TextEncoder().encode(JSON.stringify({ e2ee: 1, n: 'abc==', c: 'ZGVmZ2g=' })),
    crypto.getRandomValues(new Uint8Array(2048)),
    new Uint8Array(0),
  ];
  for (const [i, bytes] of cases.entries()) {
    const payload = toPayload(bytes);
    const back = fromPayload(payload);
    const identical = Buffer.from(bytes).equals(back);
    assert(identical, `case ${i}: payload round-trips byte-identical (${bytes.length}B)`);
  }

  const frame = { t: 'mux' as const, sid: 's1', seq: 7, payload: toPayload(new Uint8Array([9, 8, 7])) };
  const decoded = decode(encode(frame));
  assert(isMuxFrame(decoded), 'encoded mux frame decodes + validates');
  assert(decoded?.seq === 7 && decoded?.payload === frame.payload, 'seq + payload survive encode/decode');
  assert(!isMuxFrame(decode('{"t":"presence","mac":"up"}')), 'presence is not a mux frame');
  assert(decode('not json') === null, 'non-JSON decodes to null (no throw)');
}

function testCloseCodes(): void {
  console.log('\n[5] close-code namespaces');
  assert(isMacOriginCloseCode(CLOSE.TOKEN_REVOKED), '4401 is Mac-origin (passthrough)');
  assert(isMacOriginCloseCode(CLOSE.HANDSHAKE_REJECTED), '4403 is Mac-origin (passthrough)');
  assert(!isMacOriginCloseCode(CLOSE.MAC_OFFLINE), '4408 is relay-origin (NOT passthrough)');
  assert(!isMacOriginCloseCode(CLOSE.ENTITLEMENT_LAPSED), '4409 is relay-origin (NOT passthrough)');
  assert(!isMacOriginCloseCode(1000), '1000 is not a Mac-origin code');
  assert(
    CLOSE.MAC_OFFLINE === 4408 && CLOSE.ENTITLEMENT_LAPSED === 4409 && CLOSE.TOKEN_REVOKED === 4401 && CLOSE.HANDSHAKE_REJECTED === 4403,
    'close codes match the frozen wire contract',
  );
}

async function main(): Promise<void> {
  console.log('\n[relay contract-test] pure-logic invariants\n');
  await testPlanJwt();
  testRouting();
  testRateLimits();
  testMuxIntegrity();
  testCloseCodes();
  if (failures > 0) {
    console.error(`\n[relay contract-test] ${failures} FAILURE(S)\n`);
    process.exit(1);
  }
  console.log('\n[relay contract-test] OK — all invariants hold.\n');
}

main().catch((err) => {
  console.error('[relay contract-test] ERROR:', err);
  process.exit(1);
});
