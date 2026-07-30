import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';

import {
  b64encode,
  b64decode,
  signDetached,
  verifyDetached,
  helloTranscript,
  initTranscript,
  deriveSessionKey,
  encryptFrame,
  decryptFrame,
  isEncryptedFrame,
} from '@/lib/mobile/e2ee-crypto';

/**
 * #5 mobile E2EE — full handshake round-trip, simulating BOTH sides with the
 * canonical helpers. This is the executable proof that `docs/internals/mobile-e2ee.md` is
 * internally consistent and the reference the o8-mobile engineer reproduces.
 */
describe('#5 mobile E2EE handshake', () => {
  it('mutually-authenticated signed-ephemeral ECDH derives a shared key + round-trips frames', () => {
    // Long-term identities (Ed25519): server persistent, device registered at enroll.
    const serverIdentity = nacl.sign.keyPair();
    const deviceIdentity = nacl.sign.keyPair();
    const serverIdentityPubB64 = b64encode(serverIdentity.publicKey);
    const deviceIdentityPubB64 = b64encode(deviceIdentity.publicKey);

    // Per-connection ephemeral X25519 keypairs.
    const serverEph = nacl.box.keyPair();
    const clientEph = nacl.box.keyPair();
    const serverEphPubB64 = b64encode(serverEph.publicKey);
    const clientEphPubB64 = b64encode(clientEph.publicKey);
    const serverNonceB64 = b64encode(nacl.randomBytes(24));
    const clientNonceB64 = b64encode(nacl.randomBytes(24));

    // 1. server signs hello; client verifies against the PINNED server identity.
    const serverSig = signDetached(helloTranscript(serverEphPubB64, serverNonceB64), serverIdentity.secretKey);
    expect(verifyDetached(helloTranscript(serverEphPubB64, serverNonceB64), serverSig, serverIdentityPubB64)).toBe(true);

    // 2. client signs init (binds both halves); server verifies against the registered device identity.
    const initMsg = initTranscript(clientEphPubB64, clientNonceB64, serverEphPubB64, serverNonceB64);
    const clientSig = signDetached(initMsg, deviceIdentity.secretKey);
    expect(verifyDetached(initMsg, clientSig, deviceIdentityPubB64)).toBe(true);

    // 3. both derive the session key independently — they MUST match.
    const serverSessionKey = deriveSessionKey(serverEph.secretKey, clientEph.publicKey, serverEphPubB64, clientEphPubB64);
    const clientSessionKey = deriveSessionKey(clientEph.secretKey, serverEph.publicKey, serverEphPubB64, clientEphPubB64);
    expect(b64encode(serverSessionKey)).toBe(b64encode(clientSessionKey));

    // 4. a frame encrypted by the server decrypts on the client (and vice versa).
    const envelope = JSON.stringify({ channel: 'system', event: 'e2ee-ready' });
    const frame = encryptFrame(envelope, serverSessionKey);
    expect(isEncryptedFrame(frame)).toBe(true);
    expect(decryptFrame(frame, clientSessionKey)).toBe(envelope);

    const action = JSON.stringify({ type: 'orchestrator-send', message: 'hi' });
    expect(decryptFrame(encryptFrame(action, clientSessionKey), serverSessionKey)).toBe(action);
  });

  it('rejects a tampered/forged server signature (MITM with the wrong identity key)', () => {
    const realServer = nacl.sign.keyPair();
    const attacker = nacl.sign.keyPair();
    const eph = nacl.box.keyPair();
    const ephB64 = b64encode(eph.publicKey);
    const nonceB64 = b64encode(nacl.randomBytes(24));
    const msg = helloTranscript(ephB64, nonceB64);
    const attackerSig = signDetached(msg, attacker.secretKey);
    // pinned identity is the real server's — the attacker's signature must fail.
    expect(verifyDetached(msg, attackerSig, b64encode(realServer.publicKey))).toBe(false);
  });

  it('a frame does not decrypt under the wrong session key', () => {
    const k1 = nacl.randomBytes(32);
    const k2 = nacl.randomBytes(32);
    const frame = encryptFrame(JSON.stringify({ type: 'ping' }), k1);
    expect(decryptFrame(frame, k2)).toBeNull();
  });

  it('isEncryptedFrame only matches the {e2ee:1,n,c} shape', () => {
    expect(isEncryptedFrame({ channel: 'system', event: 'connected' })).toBe(false);
    expect(isEncryptedFrame({ e2ee: 1, n: 'x', c: 'y' })).toBe(true);
    expect(isEncryptedFrame({ e2ee: 1, n: 'x' })).toBe(false);
    expect(b64decode(b64encode(new Uint8Array([1, 2, 3]))).length).toBe(3);
  });
});
