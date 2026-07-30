/**
 * Mobile E2EE — pure server-side handshake state machine (Orca teardown #5).
 *
 * The protocol logic, lifted out of the ws-server so it's unit-testable without a
 * socket. ws-server owns the I/O (send the hello, hold per-connection state,
 * wrap/unwrap frames); this owns the crypto decisions. Mirrors the mobile client
 * exactly — same transcripts + KDF as docs/internals/mobile-e2ee.md / e2ee-crypto.ts.
 */

import nacl from 'tweetnacl';

import {
  b64encode,
  b64decode,
  signDetached,
  verifyDetached,
  helloTranscript,
  initTranscript,
  deriveSessionKey,
} from '@/lib/mobile/e2ee-crypto';
import type { ServerIdentity } from '@/lib/mobile/e2ee-identity';

/** Per-connection server handshake secrets (held until e2ee-init lands). */
export interface ServerHandshake {
  ephSecretKey: Uint8Array;
  serverEphPubB64: string;
  serverNonceB64: string;
  /** The connecting device's registered Ed25519 identity pub — verifies e2ee-init. */
  deviceIdentityPubB64: string;
}

/** The `e2ee-hello` payload (sent plaintext, signed by the server identity). */
export interface HelloPayload {
  v: 1;
  serverEphPub: string;
  serverNonce: string;
  serverIdentityPub: string;
  serverSig: string;
}

/** Start a handshake: fresh ephemeral keypair + a signed hello to send. */
export function startServerHandshake(
  identity: ServerIdentity,
  deviceIdentityPubB64: string,
): { handshake: ServerHandshake; hello: HelloPayload } {
  const eph = nacl.box.keyPair();
  const serverEphPubB64 = b64encode(eph.publicKey);
  const serverNonceB64 = b64encode(nacl.randomBytes(24));
  const serverSig = signDetached(helloTranscript(serverEphPubB64, serverNonceB64), identity.secretKey);
  return {
    handshake: { ephSecretKey: eph.secretKey, serverEphPubB64, serverNonceB64, deviceIdentityPubB64 },
    hello: {
      v: 1,
      serverEphPub: serverEphPubB64,
      serverNonce: serverNonceB64,
      serverIdentityPub: identity.publicKeyB64,
      serverSig,
    },
  };
}

export interface InitPayload {
  clientEphPub?: unknown;
  clientNonce?: unknown;
  clientSig?: unknown;
}

/**
 * Complete the handshake from the client's `e2ee-init`: verify the client's
 * transcript signature against its registered identity, then derive the session
 * key. Returns the key on success or a reason on failure (caller closes the WS).
 */
export function completeServerHandshake(
  h: ServerHandshake,
  init: InitPayload,
): { sessionKey: Uint8Array } | { error: string } {
  const clientEphPubB64 = typeof init.clientEphPub === 'string' ? init.clientEphPub : '';
  const clientNonceB64 = typeof init.clientNonce === 'string' ? init.clientNonce : '';
  const clientSig = typeof init.clientSig === 'string' ? init.clientSig : '';
  if (!clientEphPubB64 || !clientNonceB64 || !clientSig) {
    return { error: 'malformed e2ee-init' };
  }
  const transcript = initTranscript(clientEphPubB64, clientNonceB64, h.serverEphPubB64, h.serverNonceB64);
  if (!verifyDetached(transcript, clientSig, h.deviceIdentityPubB64)) {
    return { error: 'bad client signature' };
  }
  const sessionKey = deriveSessionKey(h.ephSecretKey, b64decode(clientEphPubB64), h.serverEphPubB64, clientEphPubB64);
  return { sessionKey };
}
