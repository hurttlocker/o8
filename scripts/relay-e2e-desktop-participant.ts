/**
 * e2e-desktop-participant — the REAL Mac half of the joint relay cross-network e2e.
 *
 * Runs the production `RelayConnector` (not a fake) against a LOCAL relay, bridging
 * to the already-running o8.app on this Mac (ports via resolvePortInfo → ~/.o8/{api,ws}-port).
 * So the loop under test is: real phone client → local relay → THIS connector →
 * the running desktop's ws-server + Next → back. No desktop rebuild, no port collision.
 *
 * It mints a throwaway founder plan-JWT from a freshly generated Ed25519 keypair and
 * prints the PUBLIC key — paste that as the local relay's LICENSE_PUBLIC_KEY so the
 * relay's entitlement gate accepts this connector. The E2EE identity + routingId come
 * from the REAL ~/.o8/e2ee-identity.key (the key the phone pinned at pairing), so an
 * already-paired phone derives the same routingId and completes the handshake.
 *
 * Start the local relay from the private `o8-relay` repo, then run from this repo:
 *   O8_RELAY_URL=ws://127.0.0.1:8787 npx tsx scripts/relay-e2e-desktop-participant.ts
 * Stop: Ctrl-C.  Env override O8_E2E_PLAN=founder|pro|team to test other tiers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, exportSPKI, generateKeyPair, importJWK, SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import { RelayConnector } from '@/lib/mobile/relay-connector';
import type { Plan } from '@/lib/entitlement/types';

const P = '[e2e-desktop]';

async function main(): Promise<void> {
  const relayUrl = process.env.O8_RELAY_URL;
  if (!relayUrl) {
    console.error(`${P} set O8_RELAY_URL to the local relay, e.g. ws://127.0.0.1:8787`);
    process.exit(1);
  }
  const issuer = process.env.O8_E2E_ISSUER || 'o8-license';
  // TWO strategies for the founder-gated relay token:
  //  - default (throwaway): mint a founder JWT from a fresh keypair; the relay must
  //    verify against the PUBLIC key this prints. Tests all relay mechanics without a
  //    real founder account. Use when the relay is pointed at a test pubkey.
  //  - O8_E2E_USE_CACHED=1: present this Mac's REAL cached license token (readCachedEntitlement).
  //    Only works if the app is signed into a founder account; verifies against the
  //    PRODUCTION license pubkey. Use for a production-faithful drive.
  let plan: Plan = (process.env.O8_E2E_PLAN as Plan) || 'founder';
  let licenseToken: string;
  let publicPem = '(using the Mac’s real cached token — relay must verify against the PRODUCTION license pubkey)';
  if (process.env.O8_E2E_USE_CACHED === '1') {
    const { readCachedEntitlement } = await import('@/lib/entitlement/license');
    const cached = readCachedEntitlement();
    if (!cached?.licenseKey) {
      console.error(`${P} O8_E2E_USE_CACHED=1 but no cached license on this Mac — sign into a founder account in the app first.`);
      process.exit(1);
    }
    plan = cached.plan as Plan;
    licenseToken = cached.licenseKey;
    if (plan !== 'founder' && plan !== 'pro' && plan !== 'team') {
      console.error(`${P} cached plan is '${plan}' — relay is paid-tier gated, this will be refused 4409. Sign in as founder.`);
      process.exit(1);
    }
  } else {
    // Persist the throwaway keypair so the PUBLIC key the relay is configured with
    // stays STABLE across connector restarts (4409 stands the connector down, so a
    // restart is expected mid-drive — a fresh key each run would break the relay's
    // configured LICENSE_PUBLIC_KEY). Delete the keyfile to rotate.
    const keyfile = process.env.O8_E2E_KEYFILE || join(homedir(), '.o8', 'relay-e2e-testkey.json');
    let publicKey: CryptoKey;
    let privateKey: CryptoKey;
    if (existsSync(keyfile)) {
      const saved = JSON.parse(readFileSync(keyfile, 'utf8')) as { priv: JsonWebKey; pub: JsonWebKey };
      privateKey = (await importJWK(saved.priv, 'EdDSA')) as CryptoKey;
      publicKey = (await importJWK(saved.pub, 'EdDSA')) as CryptoKey;
    } else {
      ({ publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true }));
      writeFileSync(keyfile, JSON.stringify({ priv: await exportJWK(privateKey), pub: await exportJWK(publicKey) }));
      console.log(`${P} generated + persisted throwaway keypair → ${keyfile}`);
    }
    publicPem = await exportSPKI(publicKey);
    licenseToken = await new SignJWT({ plan })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(issuer)
      .setSubject('e2e-test-mac')
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(privateKey);
  }

  const connector = new RelayConnector({
    plan,
    settingEnabled: true,
    relayUrl,
    licenseToken,
    blockedApprovalCount: () => 0,
  });

  console.log(`\n${P} ───────────────────────────────────────────────────────────`);
  console.log(`${P} relay URL       : ${relayUrl}`);
  console.log(`${P} plan            : ${plan}  (issuer ${issuer})`);
  console.log(`${P} routingId       : ${connector.id}`);
  console.log(`${P}   → phone dials : ${relayUrl.replace(/\/$/, '')}/device/${connector.id}`);
  console.log(`${P} bridges to      : the running o8.app (127.0.0.1 api/ws via ~/.o8 ports)`);
  console.log(`${P} ── paste this into the local relay's LICENSE_PUBLIC_KEY: ──`);
  console.log(publicPem);
  console.log(`${P} ───────────────────────────────────────────────────────────\n`);

  connector.start();
  console.log(`${P} connector started — dialing the relay. Ctrl-C to stop.`);

  const shutdown = () => {
    console.log(`\n${P} stopping.`);
    try { (connector as unknown as { stop?: () => void }).stop?.(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the event loop alive.
  setInterval(() => { /* heartbeat */ }, 1 << 30);
}

main().catch((err) => {
  console.error(`${P} fatal:`, err);
  process.exit(1);
});
