import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical';

describe('canonicalJson', () => {
  it('sorts object keys without whitespace', () => {
    expect(canonicalJson({ zebra: 1, alpha: 2, middle: 3 }))
      .toBe('{"alpha":2,"middle":3,"zebra":1}');
  });

  it('sorts nested objects while preserving array order', () => {
    expect(canonicalJson({
      outer: [{ z: true, a: false }, { second: 2, first: 1 }],
      alpha: { delta: 4, beta: 2 },
    })).toBe('{"alpha":{"beta":2,"delta":4},"outer":[{"a":false,"z":true},{"first":1,"second":2}]}');
  });

  it('preserves unicode as UTF-8 JSON text', () => {
    expect(Buffer.from(canonicalJson({ message: '雪とcafé', emoji: '🧾' }), 'utf8').toString('hex'))
      .toBe(Buffer.from('{"emoji":"🧾","message":"雪とcafé"}', 'utf8').toString('hex'));
  });
});
