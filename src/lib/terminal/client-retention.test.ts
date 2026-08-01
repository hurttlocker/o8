import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_TERMINAL_IMAGE_CHARS,
  MAX_INLINE_TERMINAL_IMAGES,
  retainInlineTerminalImages,
} from './client-retention';

describe('terminal client retention', () => {
  it('keeps only the newest image overlays', () => {
    const images = Array.from({ length: MAX_INLINE_TERMINAL_IMAGES + 3 }, (_, index) => ({
      id: index,
      dataUrl: `data:image/png;base64,${index}`,
    }));
    expect(retainInlineTerminalImages(images).map((image) => image.id)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('applies a total data-url budget while retaining the newest image', () => {
    const chunk = 'x'.repeat(Math.floor(MAX_INLINE_TERMINAL_IMAGE_CHARS * 0.6));
    const images = [
      { id: 1, dataUrl: chunk },
      { id: 2, dataUrl: chunk },
      { id: 3, dataUrl: chunk },
    ];
    expect(retainInlineTerminalImages(images).map((image) => image.id)).toEqual([3]);
  });

  it('rejects a single image larger than the total budget', () => {
    const images = [{ id: 1, dataUrl: 'x'.repeat(MAX_INLINE_TERMINAL_IMAGE_CHARS + 1) }];
    expect(retainInlineTerminalImages(images)).toEqual([]);
  });
});
