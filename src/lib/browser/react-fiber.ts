/**
 * React component-name discovery for Design Mode element enrichment (Cursor
 * parity, 2026-07-12). Cursor's select-boxes attach the React component name of
 * the element underneath (`<NodeGraph>`); our DRAW must carry the same payload.
 *
 * Same dual-form no-drift pattern as `selector.ts` / `grab.ts`:
 *  - `reactComponentName(el)` — the real function, imported by app-context
 *    surfaces (the iframe-path `DesignModeOverlay`).
 *  - `REACT_COMPONENT_NAME_SOURCE` — the SAME function as an injectable source
 *    string (derived via `.toString()`, never hand-copied) for the native
 *    browser-view agent, which can't import from `@/lib`.
 *
 * The walk is deliberately DEFENSIVE: React attaches its fiber under a
 * `__reactFiber$<random>` (React 16+) or `__reactInternalInstance$<random>`
 * (older) OWN ENUMERABLE key on the DOM node. We find that key, then climb the
 * fiber's `.return` chain to the nearest fiber whose `type` is a named
 * function/class (host fibers have a string `type` like `'div'` and are
 * skipped). forwardRef (`type.render`) and memo (`type.type`) wrappers are
 * unwrapped. Non-React pages, or production builds that minified names away,
 * simply yield `null` — every access is guarded so this never throws into a
 * pointer handler.
 *
 * Written plainly (let/const, no spread/arrow) so the `.toString()`-derived
 * source stays clean + parseable inside the createElement-only injected agent
 * (`native-agent-source.ts`), which runs on hardened CSP/Trusted-Types pages
 * (WebKit — block scope is fine, matching `selector.ts` / `grab.ts`).
 */

export function reactComponentName(el: Element): string | null {
  try {
    let node: Element | null = el;
    for (let up = 0; node && up < 12; up++) {
      let fiber: unknown = null;
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.lastIndexOf('__reactFiber$', 0) === 0 || k.lastIndexOf('__reactInternalInstance$', 0) === 0) {
          fiber = (node as unknown as Record<string, unknown>)[k];
          break;
        }
      }
      if (fiber) {
        let f: Record<string, unknown> | null = fiber as Record<string, unknown>;
        for (let depth = 0; f && depth < 40; depth++) {
          const t = f.type as Record<string, unknown> | string | null;
          if (t && typeof t !== 'string') {
            const to = t as Record<string, unknown>;
            const render = to.render as Record<string, unknown> | undefined;
            const inner = to.type as Record<string, unknown> | undefined;
            const name = (to.displayName as string) || (to.name as string)
              || (render ? ((render.displayName as string) || (render.name as string)) : '')
              || (inner ? ((inner.displayName as string) || (inner.name as string)) : '');
            if (
              name && typeof name === 'string' && name.length > 1
              && name.charAt(0) === name.charAt(0).toUpperCase()
              && name.charAt(0) !== name.charAt(0).toLowerCase()
            ) {
              return name;
            }
          }
          f = (f.return as Record<string, unknown> | null) || null;
        }
      }
      node = node.parentElement;
    }
  } catch {
    // Non-React page, or a prod build with names minified away — silently absent.
  }
  return null;
}

/**
 * `reactComponentName` as an injectable source string that defines
 * `reactComponentName` in the target page scope. Derived from the function above
 * (never hand-copied) so the two can't drift — `react-fiber.test.ts` locks it.
 */
export const REACT_COMPONENT_NAME_SOURCE = `var reactComponentName = ${reactComponentName.toString()};`;
