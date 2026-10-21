/** Reveal a tab inside its own strip, including when the shell uses CSS zoom. */
export function revealHeaderTab(scroller: HTMLDivElement, tab: Element) {
  const viewport = scroller.getBoundingClientRect();
  if (!viewport.width || !scroller.clientWidth) return;
  const target = tab.getBoundingClientRect();
  const scale = viewport.width / scroller.clientWidth;
  const left = (target.left - viewport.left) / scale;
  const right = (target.right - viewport.left) / scale;
  const width = right - left;
  const inset = Math.max(0, Math.min(22, (scroller.clientWidth - width) / 2));
  const delta = width >= scroller.clientWidth ? left
    : left < inset ? left - inset : right > scroller.clientWidth - inset ? right - scroller.clientWidth + inset : 0;
  if (delta) scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + delta));
}

/** Map a mouse wheel to the tab strip; preserve horizontal trackpads and zoom. */
export function scrollTabStripFromWheel(scroller: HTMLDivElement, event: WheelEvent): boolean {
  if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey) return false;
  if (event.deltaX !== 0 && event.target instanceof Node && scroller.contains(event.target)) return false;
  const maxScroll = scroller.scrollWidth - scroller.clientWidth;
  const delta = event.deltaX || event.deltaY;
  if (maxScroll <= 0 || delta === 0) return false;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
  const next = Math.max(0, Math.min(maxScroll, scroller.scrollLeft + delta * unit));
  if (next === scroller.scrollLeft) return false;
  event.preventDefault();
  scroller.scrollLeft = next;
  return true;
}
