import { createHash } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import {
  base58Encode,
  buildHttpReplay,
  chunkBase64,
  deriveRoutingId,
  passthroughCloseCode,
  relayConnectorEligible,
  RELAY_FORWARD_MARKER,
} from './relay-connector-protocol';

describe('base58Encode (must equal bs58 so the routingId matches the mobile client)', () => {
  it('matches known bs58 vectors', () => {
    expect(base58Encode(new Uint8Array())).toBe('');
    expect(base58Encode(Uint8Array.from([0]))).toBe('1');
    expect(base58Encode(Uint8Array.from([0, 0]))).toBe('11');
    expect(base58Encode(new TextEncoder().encode('hello world'))).toBe('StV1DL6CwTryKyV');
  });

  it('preserves leading zero bytes as leading 1s', () => {
    expect(base58Encode(Uint8Array.from([0, 0, 0, 1]))).toBe('1112');
  });
});

describe('deriveRoutingId', () => {
  const pub = Buffer.from('server-identity-pubkey-bytes').toString('base64');

  it('is base58(SHA-256(pubkey)[:16]) and deterministic', () => {
    const expected = base58Encode(
      createHash('sha256').update(Buffer.from(pub, 'base64')).digest().subarray(0, 16),
    );
    expect(deriveRoutingId(pub)).toBe(expected);
    expect(deriveRoutingId(pub)).toBe(deriveRoutingId(pub));
  });

  it('differs for different identity keys', () => {
    const a = deriveRoutingId(Buffer.from('key-a').toString('base64'));
    const b = deriveRoutingId(Buffer.from('key-b').toString('base64'));
    expect(a).not.toBe(b);
  });
});

describe('relayConnectorEligible (entitlement × operator toggle)', () => {
  it('free is never eligible, whatever the toggle', () => {
    expect(relayConnectorEligible('free', true)).toBe(false);
    expect(relayConnectorEligible('free', false)).toBe(false);
  });

  it('every paid tier is eligible when the toggle is on', () => {
    for (const plan of ['pro', 'team', 'founder'] as const) {
      expect(relayConnectorEligible(plan, true)).toBe(true);
    }
  });

  it('the operator toggle can disable an entitled plan', () => {
    expect(relayConnectorEligible('founder', false)).toBe(false);
  });
});

describe('buildHttpReplay — non-loopback marker + Bearer (v1.1 change 1)', () => {
  const base = 'http://127.0.0.1:3001';

  it('stamps a NON-loopback socket-truth marker + the wrapper trigger + forwards the Bearer', () => {
    const r = buildHttpReplay({ rid: '1', method: 'GET', path: '/api/mobile/inbox', authorization: 'Bearer tok' }, base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers['x-o8-client-addr']).toBe(RELAY_FORWARD_MARKER);
    expect(r.headers['x-o8-client-addr']).not.toMatch(/^127\.|::1|localhost/);
    expect(r.headers['x-o8-relay-forward']).toBe('1');
    expect(r.headers['authorization']).toBe('Bearer tok');
    expect(r.url).toBe(`${base}/api/mobile/inbox`);
  });

  it('picks up an Authorization nested in the headers object', () => {
    const r = buildHttpReplay({ path: '/api/mobile/x', headers: { Authorization: 'Bearer h' } }, base);
    expect(r.ok && r.headers['authorization']).toBe('Bearer h');
  });

  it('rejects SSRF-shaped paths (open-proxy guard)', () => {
    for (const path of ['//evil.com', 'http://evil', '/a/../b', 'relative', '', '/x\\y']) {
      expect(buildHttpReplay({ path }, base).ok).toBe(false);
    }
  });

  it('only attaches a body for non-GET/HEAD', () => {
    const b64 = Buffer.from('hi').toString('base64');
    const get = buildHttpReplay({ path: '/api/x', method: 'GET', bodyB64: b64 }, base);
    expect(get.ok && get.body).toBeUndefined();
    const post = buildHttpReplay({ path: '/api/x', method: 'POST', bodyB64: b64 }, base);
    expect(post.ok && post.body?.toString('utf8')).toBe('hi');
  });

  it('forwards only the safe header subset (never Cookie)', () => {
    const r = buildHttpReplay({ path: '/api/x', headers: { cookie: 'secret', 'content-type': 'application/json' } }, base);
    expect(r.ok && r.headers['cookie']).toBeUndefined();
    expect(r.ok && r.headers['content-type']).toBe('application/json');
  });
});

describe('chunkBase64 (R6 chunking)', () => {
  it('is a single chunk when under the cap', () => {
    expect(chunkBase64('abc', 10)).toEqual(['abc']);
  });

  it('splits large payloads into ≤cap chunks that reconstruct exactly', () => {
    const s = 'x'.repeat(1000);
    const chunks = chunkBase64(s, 256);
    expect(chunks.length).toBe(4);
    expect(chunks.every((c) => c.length <= 256)).toBe(true);
    expect(chunks.join('')).toBe(s);
  });
});

describe('passthroughCloseCode (close-code namespaces)', () => {
  it('passes Mac-origin 4401/4403 through; relay-origin codes do not', () => {
    expect(passthroughCloseCode(4401)).toBe(4401);
    expect(passthroughCloseCode(4403)).toBe(4403);
    expect(passthroughCloseCode(4408)).toBeNull();
    expect(passthroughCloseCode(4409)).toBeNull();
    expect(passthroughCloseCode(1000)).toBeNull();
  });
});
