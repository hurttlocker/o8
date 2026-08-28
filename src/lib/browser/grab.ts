/**
 * Canonical "grab" payload for Design Mode (browser consolidation, stage 2) —
 * the rich element capture an agent or the operator pulls off a live page:
 * structure + a design-focused computed-style subset + accessibility info,
 * ready to drop into an agent prompt.
 *
 * Same dual-form pattern as the shared selector: `buildGrabbedElement(el,
 * cssSelector)` is the real function (imported by the in-page agent's grab
 * verb) and `GRAB_PAYLOAD_SOURCE` is the SAME function as an injectable string
 * derived from it (for the Playwright-serialized engine grab). It is
 * self-contained — the css selector is passed IN (computed by the shared
 * `selectorFor`) so the builder references no imports and the derived string
 * is faithful regardless of bundler renaming. `grab.test.ts` locks the
 * no-drift invariant.
 */

export interface GrabbedElementDomSummary {
  role: string;
  accessibleName: string;
  ancestorChain: string[];
  boundingRect: { top: number; left: number; width: number; height: number };
  nearestLandmark: string;
}

export interface GrabbedElement {
  tagName: string;
  id: string;
  classList: string[];
  textContent: string;
  attributes: Record<string, string>;
  boundingRect: { top: number; left: number; width: number; height: number };
  cssSelector: string;
  /** Design-focused computed styles (color/type/box/layout). */
  computedStyles: Record<string, string>;
  accessibility: { role: string; name: string; ariaAttributes: Record<string, string> };
  innerHTML: string;
  outerHTML: string;
  parentChain: string[];
  /** Compact prompt-ready DOM and accessibility context. Optional so saved or
   *  externally supplied payloads from before this field remain valid. */
  domSummary?: GrabbedElementDomSummary;
  /** Optional data URL filled by the caller (a crop of a webview/engine screenshot).
   *  The in-page verbs can't capture pixels synchronously, but boundingRect
   *  lets the caller crop one after the fact. */
  screenshot?: string;
}

export function buildGrabbedElement(el: Element, cssSelector: string): GrabbedElement {
  const win = el.ownerDocument.defaultView || window;
  const computed = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const styleKeys = [
    'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight',
    'letterSpacing', 'textAlign', 'padding', 'margin', 'border', 'borderRadius',
    'boxShadow', 'display', 'position', 'width', 'height', 'gap', 'flexDirection',
    'alignItems', 'justifyContent', 'opacity', 'zIndex',
  ];
  const computedStyles: Record<string, string> = {};
  for (const key of styleKeys) {
    const value = (computed as unknown as Record<string, string>)[key];
    if (value != null && value !== '') computedStyles[key] = String(value);
  }
  const trim = (value: string, max: number) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) : text;
  };
  const describe = (node: Element) => {
    let out = node.tagName.toLowerCase();
    if (node.id) out += `#${node.id}`;
    const classes = Array.from(node.classList).slice(0, 2);
    if (classes.length) out += `.${classes.join('.')}`;
    return out;
  };
  const roleFor = (node: Element) => {
    const explicit = node.getAttribute('role');
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' && node.getAttribute('href')) return 'link';
    if (tag === 'input') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    const roles: Record<string, string> = {
      aside: 'complementary',
      button: 'button',
      footer: 'contentinfo',
      form: 'form',
      header: 'banner',
      img: 'img',
      li: 'listitem',
      main: 'main',
      nav: 'navigation',
      ol: 'list',
      select: 'combobox',
      table: 'table',
      textarea: 'textbox',
      ul: 'list',
    };
    return roles[tag] || '';
  };
  const attributes: Record<string, string> = {};
  const ariaAttributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    if (name.startsWith('aria-')) ariaAttributes[name] = attr.value;
    if (
      name === 'role' || name === 'href' || name === 'src' || name === 'alt'
      || name === 'title' || name === 'type' || name.startsWith('data-') || name.startsWith('aria-')
    ) {
      attributes[name] = attr.value;
    }
  }
  const accessibleName = () => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
        .join(' ').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 120);
    }
    const candidates = [el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'), el.textContent];
    for (const candidate of candidates) {
      const text = (candidate || '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 120);
    }
    return '';
  };
  const parentChain: string[] = [];
  let parent = el.parentElement;
  while (parent) {
    parentChain.unshift(describe(parent));
    if (parent === el.ownerDocument.body) break;
    parent = parent.parentElement;
  }
  const ancestorChain: string[] = [];
  let ancestor = el.parentElement;
  while (ancestor && ancestorChain.length < 4) {
    ancestorChain.unshift(describe(ancestor));
    ancestor = ancestor.parentElement;
  }
  const landmarkRoles = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);
  let landmark: Element | null = el;
  let nearestLandmark = '';
  while (landmark) {
    if (landmarkRoles.has(roleFor(landmark))) {
      nearestLandmark = describe(landmark);
      break;
    }
    landmark = landmark.parentElement;
  }
  const role = roleFor(el);
  const name = accessibleName();
  const boundingRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || '',
    classList: Array.from(el.classList),
    textContent: trim(el.textContent || '', 200),
    attributes,
    boundingRect,
    cssSelector,
    computedStyles,
    accessibility: { role, name, ariaAttributes },
    innerHTML: trim(el.innerHTML || '', 500),
    outerHTML: trim(el.outerHTML || '', 600),
    parentChain,
    domSummary: { role, accessibleName: name, ancestorChain, boundingRect, nearestLandmark },
  };
}

/**
 * `buildGrabbedElement` as a string that defines it in an injected/serialized
 * page scope. Derived from the function above so they cannot drift. The
 * injection site must define `selectorFor` first (SELECTOR_FOR_SOURCE) and call
 * `buildGrabbedElement(el, selectorFor(el))`.
 */
export const GRAB_PAYLOAD_SOURCE = `const buildGrabbedElement = ${buildGrabbedElement.toString()};`;
