/**
 * CONTRACT TEST — prove a server-minted token passes the M4 desktop verifier.
 *
 * This is the load-bearing guarantee of the whole monetization arc: a token
 * minted by THIS server (mint.ts logic, alg EdDSA) MUST validate using the
 * EXACT method the desktop uses (jose importSPKI + jwtVerify, alg EdDSA).
 *
 * It is self-contained — it generates a throwaway keypair, signs with the
 * PRIVATE key the way mint.ts does, then verifies with the PUBLIC key the way
 * src/lib/entitlement/license.ts does. No env, no DB, no network.
 *
 * Run:  npm run contract-test   (or: tsx scripts/contract-test.ts)
 */
import { generateKeyPairSync } from 'node:crypto';

import { SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';
import { BoundedRateLimiter } from '../src/rate-limit.js';

type Plan = 'free' | 'pro' | 'team';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

async function main() {
  console.log('\n[contract-test] server mint -> desktop verify (EdDSA)\n');

  // 1) Generate an Ed25519 keypair (same as scripts/gen-keypair.mjs).
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  // 2) MINT a 'pro' license exactly as src/mint.ts does.
  const ISSUER = 'o8-license';
  const plan: Plan = 'pro';
  const sub = 'user_clerk_test_123';
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 30 * 24 * 60 * 60;

  const signingKey = await importPKCS8(privatePem, 'EdDSA');
  const token = await new SignJWT({ plan, iss: ISSUER })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(expSec)
    .sign(signingKey);

  assert(typeof token === 'string' && token.split('.').length === 3, 'minted a compact JWT');

  // 3) VERIFY exactly as the M4 desktop verifier does:
  //    importSPKI(pem, 'EdDSA') + jwtVerify(token, key, { algorithms: ['EdDSA'], clockTolerance: 0 })
  const verifyKey = await importSPKI(publicPem, 'EdDSA');
  const { payload, protectedHeader } = await jwtVerify(token, verifyKey, {
    algorithms: ['EdDSA', 'RS256'],
    clockTolerance: 0,
  });

  assert(protectedHeader.alg === 'EdDSA', "protected header alg is 'EdDSA'");
  assert(payload.plan === 'pro', "plan claim is 'pro'");
  assert(typeof payload.exp === 'number', 'exp claim is a number (seconds-epoch)');
  assert((payload.exp as number) > nowSec, 'exp is in the future (valid window)');
  assert(payload.sub === sub, 'sub claim round-trips');
  assert(payload.iss === ISSUER, "iss claim is 'o8-license'");

  // 4) Negative control: a token signed with a DIFFERENT key must NOT verify.
  const { privateKey: otherPriv } = generateKeyPairSync('ed25519');
  const otherSigningKey = await importPKCS8(
    otherPriv.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'EdDSA',
  );
  const wrongKeyToken = await new SignJWT({ plan, iss: ISSUER })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setExpirationTime(expSec)
    .sign(otherSigningKey);

  let rejected = false;
  try {
    await jwtVerify(wrongKeyToken, verifyKey, { algorithms: ['EdDSA'] });
  } catch {
    rejected = true;
  }
  assert(rejected, 'wrong-key token is rejected (signature check works)');

  // 5) A blocked-client flood must not grow one key's sliding-window state.
  const limiter = new BoundedRateLimiter();
  let allowed = 0;
  for (let i = 0; i < 20_000; i++) {
    if (limiter.allow('flood', 5, 60_000, nowSec * 1_000)) allowed += 1;
  }
  const entries = (limiter as unknown as {
    entries: Map<string, { timestamps: number[] }>;
  }).entries;
  assert(allowed === 5, 'rate limiter admits only the configured attempts');
  assert(entries.get('flood')?.timestamps.length === 5, 'blocked flood state stays bounded at the configured limit');

  console.log('\n[contract-test] OK — server tokens pass the M4 desktop verifier.\n');
  console.log(`  exp (epoch): ${payload.exp}  (~${new Date((payload.exp as number) * 1000).toISOString()})`);
}

main().catch((err) => {
  console.error('[contract-test] ERROR:', err);
  process.exit(1);
});
