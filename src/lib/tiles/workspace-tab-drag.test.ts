import { describe, expect, it } from 'vitest';

import { workspaceTabDropZone } from './workspace-tab-drag';

const rect = { left: 100, top: 100, width: 400, height: 300 };

describe('workspace tab drop zones', () => {
  it.each([
    [110, 250, 'left'],
    [490, 250, 'right'],
    [300, 110, 'above'],
    [300, 390, 'below'],
    [300, 250, 'center'],
  ] as const)('maps (%i, %i) to %s', (x, y, zone) => {
    expect(workspaceTabDropZone(rect, x, y)).toBe(zone);
  });
});
