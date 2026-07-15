import { describe, expect, it } from 'vitest';
import { BROWSER_LOCALIZATION_ROWS_SOURCE, collectBrowserLocalizationRows } from './localization';

// Shared window mock — getComputedStyle dispatches on the element it's handed
// (the real collector calls view.getComputedStyle(element)), reading the style
// stashed on the element by the `element()` factory.
const sharedView = {
  innerWidth: 100,
  innerHeight: 80,
  getComputedStyle: (el: { _style?: { visibility?: string; opacity?: string } }) => ({
    visibility: el._style?.visibility ?? 'visible',
    opacity: el._style?.opacity ?? '1',
  }),
};
const sharedDoc = { defaultView: sharedView };

function element(
  rect: { left: number; top: number; right: number; bottom: number },
  hidden = false,
  style: { visibility?: string; opacity?: string } = {},
) {
  return {
    ownerDocument: sharedDoc,
    _style: style,
    tagName: 'BUTTON',
    getAttribute: (name: string) => name === 'aria-hidden' && hidden ? 'true' : null,
    getBoundingClientRect: () => ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }),
  } as unknown as Element;
}

describe('collectBrowserLocalizationRows', () => {
  it('clips visible controls and rejects hidden or offscreen targets', () => {
    const visible = element({ left: -5, top: 10, right: 35, bottom: 30 });
    const offscreen = element({ left: 110, top: 10, right: 150, bottom: 30 });
    const hidden = element({ left: 10, top: 10, right: 30, bottom: 30 }, true);
    const root = {
      ownerDocument: visible.ownerDocument,
      querySelectorAll: () => [visible, offscreen, hidden],
    } as unknown as ParentNode;

    const rows = collectBrowserLocalizationRows(root, () => '#save', () => 'Save');
    expect(rows).toEqual([{
      selector: '#save',
      tag: 'button',
      label: 'Save',
      rect: { left: 0, top: 10, width: 35, height: 20 },
    }]);
  });

  it('rejects visibility:hidden and opacity:0 controls that still have a rectangle (adversarial review 2026-07-15)', () => {
    const shown = element({ left: 10, top: 10, right: 40, bottom: 30 });
    const invisible = element({ left: 10, top: 40, right: 40, bottom: 60 }, false, { visibility: 'hidden' });
    const transparent = element({ left: 10, top: 60, right: 40, bottom: 78 }, false, { opacity: '0' });
    const root = {
      ownerDocument: shown.ownerDocument,
      querySelectorAll: () => [shown, invisible, transparent],
    } as unknown as ParentNode;

    const rows = collectBrowserLocalizationRows(root, () => '#a', () => 'A');
    expect(rows.map((r) => r.selector)).toEqual(['#a']);
  });

  it('exports the exact collector as injectable source', () => {
    expect(BROWSER_LOCALIZATION_ROWS_SOURCE).toContain(collectBrowserLocalizationRows.toString());
  });
});
