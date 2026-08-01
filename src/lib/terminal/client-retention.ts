export const TERMINAL_SCROLLBACK_LINES = 3_000;
export const MAX_INLINE_TERMINAL_IMAGES = 6;
export const MAX_INLINE_TERMINAL_IMAGE_CHARS = 32 * 1024 * 1024;

export function retainInlineTerminalImages<T extends { dataUrl: string }>(images: T[]): T[] {
  const retained: T[] = [];
  let retainedChars = 0;

  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index];
    if (!image || retained.length >= MAX_INLINE_TERMINAL_IMAGES) break;
    const nextChars = retainedChars + image.dataUrl.length;
    if (nextChars > MAX_INLINE_TERMINAL_IMAGE_CHARS) continue;
    retained.unshift(image);
    retainedChars = nextChars;
  }

  return retained;
}
