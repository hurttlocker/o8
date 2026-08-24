import { describe, expect, it } from 'vitest';
import { wrapEvalCode } from './o8-webview-tools';

/** The wrapper is a self-contained expression; run it the way the webview does. */
function runWrapped(userCode: string): { ok: boolean; value?: unknown; error?: { name: string; message: string } } {
  // eslint-disable-next-line no-eval
  return JSON.parse((0, eval)(wrapEvalCode(userCode)) as string);
}

describe('wrapEvalCode', () => {
  it('reports a Promise result honestly instead of returning {} as success (#1735)', () => {
    // The transport reads a synchronous completion value, and a pending Promise
    // has no own enumerable keys -- so it serialized to {} and passed every
    // serializability probe as ok:true. The caller was told the eval worked.
    const result = runWrapped('Promise.resolve(42)');
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe('AsyncEvalUnsupported');
    expect(result.error?.message).toContain('second, synchronous eval');
  });

  it('catches an async IIFE the same way', () => {
    const result = runWrapped('(async () => 1)()');
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe('AsyncEvalUnsupported');
  });

  it('catches a bare thenable', () => {
    expect(runWrapped('({ then: function (r) { r(1); } })').ok).toBe(false);
  });

  it('still returns ordinary synchronous values', () => {
    expect(runWrapped('1 + 1')).toMatchObject({ ok: true, value: 2 });
    expect(runWrapped('({ a: 1, b: "two" })')).toMatchObject({ ok: true, value: { a: 1, b: 'two' } });
    expect(runWrapped('"plain string"')).toMatchObject({ ok: true, value: 'plain string' });
    expect(runWrapped('[1, 2, 3]')).toMatchObject({ ok: true, value: [1, 2, 3] });
  });

  it('still reports a thrown error as an error', () => {
    const result = runWrapped('throw new TypeError("boom")');
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe('TypeError');
    expect(result.error?.message).toBe('boom');
  });

  it('does not mistake an object with a non-callable then for a promise', () => {
    expect(runWrapped('({ then: "not a function" })')).toMatchObject({ ok: true });
  });
});
