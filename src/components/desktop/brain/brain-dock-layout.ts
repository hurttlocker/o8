export function brainDockLayout(anchor: { left: number; top: number; width: number }, viewportWidth: number) {
  const width = Math.min(400, Math.max(240, anchor.width), viewportWidth - 24);
  const height = Math.max(96, Math.min(320, anchor.top - 36));
  return {
    left: Math.max(12, Math.min(anchor.left + anchor.width - width, viewportWidth - width - 12)),
    top: Math.max(8, anchor.top - height - 20), width, height,
  };
}
