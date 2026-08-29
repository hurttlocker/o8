import { describe, expect, it, vi } from 'vitest';
import { resizeTerminalIfChanged } from './terminal-resize';

describe('resizeTerminalIfChanged', () => {
  it('skips an unchanged grid and resizes once when dimensions change', () => {
    const resize = vi.fn();
    const attachment = { cols: 120, rows: 30, ptyProcess: { resize } };

    expect(resizeTerminalIfChanged(attachment, 120, 30)).toBe(false);
    expect(resize).not.toHaveBeenCalled();

    expect(resizeTerminalIfChanged(attachment, 100, 24)).toBe(true);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(100, 24);
    expect(attachment).toMatchObject({ cols: 100, rows: 24 });
  });
});
