/**
 * Mobile E2EE — the canonical crypto operations (platform teardown #5).
 *
 * This module is the executable half of `docs/internals/mobile-e2ee.md`. The o8-mobile
 * (Expo) client mirrors these EXACT operations with the same `tweetnacl`
 * primitives — so the transcript strings, the key-derivation, and the frame
 * format here are a wire contract, not an implementation detail. Change them in
 * lockstep on both sides or the channel silently fails to decrypt.
 *
 * Construction: mutually-authenticated signed ephemeral X25519 ECDH →
 * XSalsa20-Poly1305 (NaCl secretbox), forward-secret per connection.
 * - Identity keys: Ed25519 (`nacl.sign`) — long-term, authenticate the handshake.
 * - Ephemeral keys: X25519 (`nacl.box`) — per connection, give forward secrecy.
 * - Session key: SHA-512(sharedX || serverEphPub || clientEphPub)[:32], channel-bound.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

export const E2EE_PROTOCOL = 'o8-e2ee-v1';
export const NONCE_BYTES = nacl.secretbox.nonceLength; // 24
export const SESSION_KEY_BYTES = nacl.secretbox.keyLength; // 32

export function b64encode(bytes: Uint8Array): string {
  return naclUtil.encodeBase64(bytes);
}

export function b64decode(value: string): Uint8Array {
  return naclUtil.decodeBase64(value);
}

function utf8(value: string): Uint8Array {
  return naclUtil.decodeUTF8(value);
}

/** Detached Ed25519 signature over a UTF-8 string, base64-encoded. */
export function signDetached(message: string, identitySecretKey: Uint8Array): string {
  return b64encode(nacl.sign.detached(utf8(message), identitySecretKey));
}

/** Verify a base64 detached Ed25519 signature against a base64 public key. */
export function verifyDetached(message: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    return nacl.sign.detached.verify(utf8(message), b64decode(signatureB64), b64decode(publicKeyB64));
  } catch {
    return false;
  }
}

/** The exact transcript strings each side signs — DO NOT reformat (wire contract). */
export function helloTranscript(serverEphPubB64: string, serverNonceB64: string): string {
  return `${E2EE_PROTOCOL}|hello|${serverEphPubB64}|${serverNonceB64}`;
}

export function initTranscript(
  clientEphPubB64: string,
  clientNonceB64: string,
  serverEphPubB64: string,
  serverNonceB64: string,
): string {
  return `${E2EE_PROTOCOL}|init|${clientEphPubB64}|${clientNonceB64}|${serverEphPubB64}|${serverNonceB64}`;
}

/**
 * Derive the per-connection session key. `box.before` is symmetric — both sides
 * compute the same 32-byte X25519 shared key — and the transcript suffix
 * (serverEphPub || clientEphPub) is identical on both sides, so both derive the
 * same channel-bound session key.
 */
export function deriveSessionKey(
  ownEphSecretKey: Uint8Array,
  peerEphPublicKey: Uint8Array,
  serverEphPubB64: string,
  clientEphPubB64: string,
): Uint8Array {
  const shared = nacl.box.before(peerEphPublicKey, ownEphSecretKey); // X25519 → 32B
  const transcript = new Uint8Array([
    ...shared,
    ...b64decode(serverEphPubB64),
    ...b64decode(clientEphPubB64),
  ]);
  return nacl.hash(transcript).subarray(0, SESSION_KEY_BYTES); // SHA-512 → first 32B
}

export interface EncryptedFrame {
  e2ee: 1;
  n: string; // base64 nonce
  c: string; // base64 ciphertext
}

export function isEncryptedFrame(value: unknown): value is EncryptedFrame {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { e2ee?: unknown }).e2ee === 1
    && typeof (value as { n?: unknown }).n === 'string'
    && typeof (value as { c?: unknown }).c === 'string';
}

/** Encrypt a plaintext JSON string into an `{e2ee,n,c}` frame. */
export function encryptFrame(plaintext: string, sessionKey: Uint8Array): EncryptedFrame {
  const nonce = nacl.randomBytes(NONCE_BYTES);
  const box = nacl.secretbox(utf8(plaintext), nonce, sessionKey);
  return { e2ee: 1, n: b64encode(nonce), c: b64encode(box) };
}

/** Decrypt an `{e2ee,n,c}` frame back to its plaintext JSON string, or null on failure. */
export function decryptFrame(frame: EncryptedFrame, sessionKey: Uint8Array): string | null {
  try {
    const opened = nacl.secretbox.open(b64decode(frame.c), b64decode(frame.n), sessionKey);
    if (!opened) return null;
    return naclUtil.encodeUTF8(opened);
  } catch {
    return null;
  }
}
