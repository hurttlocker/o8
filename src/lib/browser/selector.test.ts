import { describe, it, expect } from 'vitest';
import { selectorFor, SELECTOR_FOR_SOURCE } from './selector';

// `CSS.escape` is a browser global; stub it for the node test runtime.
(globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= {
  escape: (s: string) => String(s),
};

/** Reconstruct `selectorFor` from the injectable source, exactly as the
 *  serialized engine context does. */
function reifyFromSource(): (el: unknown) => string {

  return new Function(`${SELECTOR_FOR_SOURCE}; return selectorFor;`)() as (el: unknown) => string;
}

describe('shared selectorFor', () => {
  it('takes the id shortcut', () => {
    const el = { id: 'composer', ownerDocument: { documentElement: {} } } as unknown as Element;
    expect(selectorFor(el)).toBe('#composer');
  });

  it('SELECTOR_FOR_SOURCE reconstructs to a working function with identical output', () => {
    const reified = reifyFromSource();
    expect(typeof reified).toBe('function');
    const el = { id: 'composer', ownerDocument: { documentElement: {} } };
    expect(reified(el)).toBe(selectorFor(el as unknown as Element));
  });

  it('SELECTOR_FOR_SOURCE is derived from the function (cannot drift)', () => {
    // If someone replaces the derivation with a hand-written copy, this fails —
    // forcing the string to stay generated from `selectorFor`.
    expect(SELECTOR_FOR_SOURCE).toContain(selectorFor.toString());
  });

  it('carries the canonical algorithm markers', () => {
    for (const marker of ['nth-of-type', 'querySelectorAll', '=== 1', 'CSS.escape', 'documentElement']) {
      expect(SELECTOR_FOR_SOURCE).toContain(marker);
    }
  });
});
