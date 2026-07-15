/**
 * Shared DOM-target catalog for Symon screen localization. The iframe agent
 * imports this function directly; the native child-webview injects the exact
 * same function source so the two browser surfaces cannot drift.
 */

export interface BrowserLocalizationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BrowserLocalizationRow {
  selector: string;
  tag: string;
  label: string;
  rect: BrowserLocalizationRect;
}

export function collectBrowserLocalizationRows(
  root: ParentNode,
  selectorForElement: (element: Element) => string,
  labelForElement: (element: Element) => string,
  limit = 80,
): BrowserLocalizationRow[] {
  const doc = (root as Element).ownerDocument ?? (root as Document);
  const view = doc.defaultView;
  const viewportWidth = view?.innerWidth ?? Number.POSITIVE_INFINITY;
  const viewportHeight = view?.innerHeight ?? Number.POSITIVE_INFINITY;
  const query = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[onclick]',
  ].join(',');
  const rows: BrowserLocalizationRow[] = [];
  for (const element of root.querySelectorAll(query)) {
    if (rows.length >= limit) break;
    if (element.getAttribute('aria-hidden') === 'true') continue;
    const raw = element.getBoundingClientRect();
    const left = Math.max(0, raw.left);
    const top = Math.max(0, raw.top);
    const right = Math.min(viewportWidth, raw.right);
    const bottom = Math.min(viewportHeight, raw.bottom);
    if (right - left < 4 || bottom - top < 4) continue;
    rows.push({
      selector: selectorForElement(element),
      tag: element.tagName.toLowerCase(),
      label: labelForElement(element),
      rect: { left, top, width: right - left, height: bottom - top },
    });
  }
  return rows;
}

export const BROWSER_LOCALIZATION_ROWS_SOURCE =
  `const collectBrowserLocalizationRows = ${collectBrowserLocalizationRows.toString()};`;
