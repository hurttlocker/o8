/**
 * Web Push payload encryption — RFC 8291 (aes128gcm content-encoding).
 *
 * Encrypts a small JSON payload so only the subscribed browser (which holds
 * the matching p256dh/auth pair) can decrypt it. Browsers reject pushes that
 * aren't encrypted with this exact scheme.
 *
 * Issue: https://github.com/hurttlocker/o8/issues/639
 */

import 'server-only';
import {
  createECDH,
  createHmac,
  createCipheriv,
  randomBytes,
} from 'node:crypto';
import { base64UrlDecode } from './vapid';

interface SubscriptionKeys {
  /** base64url-encoded P-256 public key from the client (65-byte uncompressed) */
  p256dh: string;
  /** base64url-encoded 16-byte auth secret from the client */
  auth: string;
}

/**
 * Build an aes128gcm-encrypted Web Push request body for the given payload.
 *
 * Returns the body buffer + the Crypto-Key public key bytes that go into the
 * salt+keyid header inside the body itself (per RFC 8188).
 */
export function encryptPayload(payload: Buffer | string, sub: SubscriptionKeys): Buffer {
  const plaintext = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  if (plaintext.length > 3993) {
    // Push services cap the total request body at 4096 bytes. The body is
    // salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext(plaintext + 1 pad
    // byte) + tag(16) = plaintext + 103, so plaintext must stay ≤ 3993 or the
    // push service rejects the POST and the device gets unsubscribed.
    throw new Error(`[push-encrypt] payload too large: ${plaintext.length} bytes (max 3993)`);
  }

  // 1. Generate ephemeral ECDH keypair (sender / "as_pub").
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const senderPubRaw = ecdh.getPublicKey(); // 65-byte uncompressed

  // 2. Derive shared secret with the client's public key.
  const clientPubBytes = base64UrlDecode(sub.p256dh);
  const sharedSecret = ecdh.computeSecret(clientPubBytes);

  const authSecret = base64UrlDecode(sub.auth);
  const salt = randomBytes(16);

  // 3. Run the HKDF dance from RFC 8291 §3.4:
  //    PRK_key = HMAC-SHA256(auth_secret, ECDH(secret))
  //    keyinfo = "WebPush: info\0" || ua_pub || as_pub
  //    IKM = HMAC(PRK_key, keyinfo || 0x01) [first 32 bytes]
  //    PRK = HMAC(salt, IKM)
  //    cek = HMAC(PRK, "Content-Encoding: aes128gcm\0\x01") [first 16 bytes]
  //    nonce = HMAC(PRK, "Content-Encoding: nonce\0\x01") [first 12 bytes]

  const prkKey = hmacSha256(authSecret, sharedSecret);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf-8'),
    clientPubBytes,
    senderPubRaw,
  ]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const prk = hmacSha256(salt, ikm);

  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf-8');
  const cek = hkdfExpand(prk, cekInfo, 16);

  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'utf-8');
  const nonce = hkdfExpand(prk, nonceInfo, 12);

  // 4. Construct AES-128-GCM ciphertext over (plaintext || 0x02).
  // The 0x02 byte signals "last record" per RFC 8188.
  const block = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(block), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 5. Wrap in the RFC 8188 framing:
  //    salt(16) || rs(4 BE) || idlen(1) || keyid(idlen) || ciphertext || tag(16)
  // For Web Push, keyid is the sender public key.
  const recordSize = 4096;
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  const idLen = Buffer.from([senderPubRaw.length]); // 65
  const body = Buffer.concat([
    salt,
    rs,
    idLen,
    senderPubRaw,
    ciphertext,
    tag,
  ]);

  return body;
}

function hmacSha256(key: Buffer | Uint8Array, data: Buffer | Uint8Array): Buffer {
  const h = createHmac('sha256', key);
  h.update(data);
  return h.digest();
}

/**
 * HKDF-Expand for the small lengths we need (≤ 32 bytes — single-block case).
 * RFC 5869 step 2: T(1) = HMAC(PRK, info || 0x01); take first `length` bytes.
 */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (length > 32) {
    throw new Error('[push-encrypt] HKDF-Expand length > 32 not supported here');
  }
  const t = hmacSha256(prk, Buffer.concat([info, Buffer.from([0x01])]));
  return t.subarray(0, length);
}
