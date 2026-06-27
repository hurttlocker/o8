import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';

import { startServerHandshake, completeServerHandshake } from '@/lib/mobile/e2ee-channel';
import {
  b64encode,
  b64decode,
  signDetached,
  initTranscript,
  helloTranscript,
  verifyDetached,
  deriveSessionKey,
  encryptFrame,
  decryptFrame,
} from '@/lib/mobile/e2ee-crypto';
import type { ServerIdentity } from '@/lib/mobile/e2ee-identity';

/**
 * #5 mobile E2EE — server handshake state machine driven by a faithful CLIENT
 * (what the o8-mobile side does). Proves the server module agrees end-to-end with
 * an honest client, and rejects a forged one.
 */
function makeServerIdentity(): ServerIdentity {
  const kp = nacl.sign.keyPair();
  return { publicKeyB64: b64encode(kp.publicKey), secretKey: kp.secretKey };
}

describe('#5 mobile E2EE server handshake', () => {
  it('completes against an honest client and both derive the same session key', () => {
    const serverIdentity = makeServerIdentity();
    const device = nacl.sign.keyPair(); // device Ed25519 identity (registered at enroll)
    const deviceIdentityPubB64 = b64encode(device.publicKey);

    // server: start handshake → hello
    const { handshake, hello } = startServerHandshake(serverIdentity, deviceIdentityPubB64);

    // client: verify hello against the PINNED server identity
    expect(hello.serverIdentityPub).toBe(serverIdentity.publicKeyB64);
    expect(verifyDetached(helloTranscript(hello.serverEphPub, hello.serverNonce), hello.serverSig, hello.serverIdentityPub)).toBe(true);

    // client: ephemeral + signed init
    const clientEph = nacl.box.keyPair();
    const clientEphPubB64 = b64encode(clientEph.publicKey);
    const clientNonceB64 = b64encode(nacl.randomBytes(24));
    const clientSig = signDetached(
      initTranscript(clientEphPubB64, clientNonceB64, hello.serverEphPub, hello.serverNonce),
      device.secretKey,
    );

    // server: complete
    const result = completeServerHandshake(handshake, { clientEphPub: clientEphPubB64, clientNonce: clientNonceB64, clientSig });
    expect('sessionKey' in result).toBe(true);
    const serverKey = (result as { sessionKey: Uint8Array }).sessionKey;

    // client: derive its own key — must match the server's
    const clientKey = deriveSessionKey(clientEph.secretKey, b64decode(hello.serverEphPub), hello.serverEphPub, clientEphPubB64);
    expect(b64encode(serverKey)).toBe(b64encode(clientKey));

    // a frame the server encrypts decrypts on the client
    const env = JSON.stringify({ channel: 'system', event: 'e2ee-ready' });
    expect(decryptFrame(encryptFrame(env, serverKey), clientKey)).toBe(env);
  });

  it('rejects an e2ee-init signed by the wrong key (token theft without the device key)', () => {
    const serverIdentity = makeServerIdentity();
    const realDevice = nacl.sign.keyPair();
    const attacker = nacl.sign.keyPair();
    const { handshake, hello } = startServerHandshake(serverIdentity, b64encode(realDevice.publicKey));

    const clientEph = nacl.box.keyPair();
    const clientEphPubB64 = b64encode(clientEph.publicKey);
    const clientNonceB64 = b64encode(nacl.randomBytes(24));
    // signed by the ATTACKER, not the registered device identity
    const clientSig = signDetached(
      initTranscript(clientEphPubB64, clientNonceB64, hello.serverEphPub, hello.serverNonce),
      attacker.secretKey,
    );
    const result = completeServerHandshake(handshake, { clientEphPub: clientEphPubB64, clientNonce: clientNonceB64, clientSig });
    expect('error' in result).toBe(true);
  });

  it('rejects a malformed e2ee-init', () => {
    const { handshake } = startServerHandshake(makeServerIdentity(), b64encode(nacl.sign.keyPair().publicKey));
    expect('error' in completeServerHandshake(handshake, {})).toBe(true);
    expect('error' in completeServerHandshake(handshake, { clientEphPub: 'x', clientNonce: 'y' })).toBe(true);
  });
});
