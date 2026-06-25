/**
 * Canonical element-selector builder for the embedded-browser stack
 * (browser consolidation, stage 1). ONE algorithm, two shipping forms:
 *
 *  - `selectorFor(el)` — the real function, imported directly by the
 *    app-context surfaces (the in-page agent `page-agent.ts` and the canvas
 *    `browser-card.tsx`).
 *  - `SELECTOR_FOR_SOURCE` — the SAME function as an injectable source string,
 *    for the serialized context that can't import it: the Playwright-driven
 *    engine collector + grab (`browser-engine/engine.ts`). It is *derived from*
 *    `selectorFor` (not hand-copied) so the function and the string can never
 *    drift — `selector.test.ts` locks that invariant.
 *
 * Algorithm: id shortcut → walk up to 5 levels → tag (+ up to 2 classes)
 * + `:nth-of-type` among same-tag siblings → early-exit the moment the path
 * uniquely resolves in the document. `CSS.escape` is a browser global present
 * in every runtime this executes in (webview, the user's Chrome, localhost
 * pages).
 */

export function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== doc.documentElement && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
    if (classes) part += classes;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    try {
      if (doc.querySelectorAll(parts.join(' > ')).length === 1) return parts.join(' > ');
    } catch {
      // bad escape — keep walking
    }
    node = parent;
  }
  return parts.join(' > ');
}

/**
 * `selectorFor` as a string that, when injected/serialized into a page
 * context, defines `selectorFor` in that scope. Derived from the function
 * above so the two stay byte-identical regardless of how the bundler renames
 * the function expression.
 */
export const SELECTOR_FOR_SOURCE = `const selectorFor = ${selectorFor.toString()};`;
