export interface PipRect { left: number; top: number; width: number; height: number }
export interface PipPoint { x: number; y: number }

/** Keep the whole player in its workspace, above the composer in its columns. */
export function fitPipLayout(bounds: PipRect, preferred: { width: number; frameHeight: number; viewport: number }, position: PipPoint | null, composer: PipRect | null = null) {
  const gutter = 8; const header = 30;
  const maxWidth = Math.max(1, bounds.width - gutter * 2);
  const maxHeight = Math.max(1, bounds.height - gutter * 2 - header);
  const ratio = Math.min(1, maxWidth / preferred.width, maxHeight / preferred.frameHeight);
  let width = preferred.width * ratio; let frameHeight = preferred.frameHeight * ratio;
  const overlapsComposer = (x: number, w: number) => composer && x < composer.left + composer.width && x + w > composer.left;
  const initialX = position?.x ?? bounds.left + bounds.width - width - gutter;
  let x = Math.max(bounds.left + gutter, Math.min(initialX, bounds.left + bounds.width - width - gutter));
  const floor = overlapsComposer(x, width) ? Math.min(bounds.top + bounds.height, Math.max(bounds.top, composer!.top)) : bounds.top + bounds.height;
  const availableHeight = Math.max(1, floor - bounds.top - gutter * 2 - header);
  if (frameHeight > availableHeight) { width *= availableHeight / frameHeight; frameHeight = availableHeight; }
  x = Math.max(bounds.left + gutter, Math.min(position?.x ?? bounds.left + bounds.width - width - gutter, bounds.left + bounds.width - width - gutter));
  const y = Math.max(bounds.top + gutter, Math.min(position?.y ?? floor - frameHeight - header - gutter, floor - frameHeight - header - gutter));
  return { position: { x, y }, shape: { width, frameHeight, viewport: preferred.viewport } };
}
