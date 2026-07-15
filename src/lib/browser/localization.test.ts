import { describe, expect, it } from 'vitest';
import { BROWSER_LOCALIZATION_ROWS_SOURCE, collectBrowserLocalizationRows } from './localization';

function element(rect: { left: number; top: number; right: number; bottom: number }, hidden = false) {
  return {
    ownerDocument: { defaultView: { innerWidth: 100, innerHeight: 80 } },
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

  it('exports the exact collector as injectable source', () => {
    expect(BROWSER_LOCALIZATION_ROWS_SOURCE).toContain(collectBrowserLocalizationRows.toString());
  });
});
