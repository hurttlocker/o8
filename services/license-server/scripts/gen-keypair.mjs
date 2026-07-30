#!/usr/bin/env node
/**
 * Generate an Ed25519 keypair for o8 license signing.
 *
 *   - PRIVATE key (PKCS8 PEM)  -> set as Railway env var LICENSE_PRIVATE_KEY
 *   - PUBLIC key  (SPKI PEM)   -> paste into the desktop app at
 *                                 src/lib/entitlement/license.ts as the value
 *                                 of LICENSE_PUBLIC_KEY_PEM.
 *
 * The desktop verifier imports the public key via importSPKI(pem, 'EdDSA') and
 * the server signs with importPKCS8(privateKey, 'EdDSA'). As long as this pair
 * matches, server tokens validate on the desktop.
 *
 * Usage:  node scripts/gen-keypair.mjs   (or: npm run gen-keys)
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();

const line = '='.repeat(72);

console.log('');
console.log(line);
console.log('  o8 LICENSE SIGNING KEYPAIR (Ed25519)  —  generated', new Date().toISOString());
console.log(line);
console.log('');
console.log('1) PRIVATE KEY  ->  Railway env var:  LICENSE_PRIVATE_KEY');
console.log('   Keep this SECRET. It lives ONLY on the license server. Never commit it.');
console.log('   (Railway lets you paste multi-line values directly.)');
console.log('');
console.log(privatePem);
console.log('');
console.log(line);
console.log('');
console.log('2) PUBLIC KEY  ->  Desktop app:  src/lib/entitlement/license.ts');
console.log('   Replace the LICENSE_PUBLIC_KEY_PEM value with the block below.');
console.log('   This is safe to commit — it only VERIFIES tokens.');
console.log('');
console.log(publicPem);
console.log('');
console.log(line);
console.log('');
console.log('NEXT STEPS');
console.log('  - Railway:  Variables tab -> add LICENSE_PRIVATE_KEY (the private block above)');
console.log('  - Desktop:  edit src/lib/entitlement/license.ts, swap in the public block,');
console.log('              then ship a desktop build so users get the new verifier key.');
console.log('  - You can also override the desktop key at runtime via O8_LICENSE_PUBKEY.');
console.log('');
