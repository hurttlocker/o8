import { selectorFor } from '@/lib/browser/selector';
import type { VisualElementCandidate, VisualObservation, VisualRect } from './visual-inspection';

interface ElementSnapshot { element: Element; rect: DOMRect; name: string; role: string; selector: string }
export interface VisualElementSnapshot { epoch: number; width: number; height: number; elements: ElementSnapshot[] }
let epoch = 0;
let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  const changed = () => { epoch++; };
  window.addEventListener('scroll', changed, true); window.addEventListener('resize', changed);
  new MutationObserver(changed).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
}
/** Capture actual semantic elements before the stroke; later DOM/scroll changes discard them. */
export function snapshotVisualElements(): VisualElementSnapshot {
  watch();
  const elements: ElementSnapshot[] = [];
  const started = performance.now();
  for (const element of document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="tab"],[role="checkbox"]')) {
    if (performance.now() - started >= 100) { elements.length = 0; break; }
    if (elements.length >= 512) break;
    if (element.closest('[inert], [aria-hidden="true"]')) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
    const hit = document.elementFromPoint?.(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
    if (!hit || !element.contains(hit)) continue;
    const name = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('placeholder') || '').trim().slice(0, 180);
    if (!name) continue;
    elements.push({ element, rect, name, role: element.getAttribute('role') || element.tagName.toLowerCase(), selector: selectorFor(element).slice(0, 500) });
  }
  return { epoch, width: innerWidth, height: innerHeight, elements };
}
export function visualElementCandidates(snapshot: VisualElementSnapshot | undefined, observation: VisualObservation): VisualElementCandidate[] {
  const viewport = observation.webviewRect;
  if (!snapshot || !viewport || snapshot.epoch !== epoch || snapshot.width !== innerWidth || snapshot.height !== innerHeight
    || Math.abs(viewport[2] - innerWidth) > 1 || Math.abs(viewport[3] - innerHeight) > 1) return [];
  const points = observation.strokes.flatMap(stroke => stroke.points);
  const [sx, sy, sw, sh] = observation.screen;
  const xs = points.map(point => sx + point.x * sw); const ys = points.map(point => sy + point.y * sh);
  const mark = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return snapshot.elements.flatMap(({ element, rect, name, role, selector }, index) => {
    if (!element.isConnected) return [];
    const left = viewport[0] + rect.left; const top = viewport[1] + rect.top;
    const right = left + rect.width; const bottom = top + rect.height;
    if (right < mark[0] || left > mark[2] || bottom < mark[1] || top > mark[3]) return [];
    const x = Math.max(0, (left - sx) / sw); const y = Math.max(0, (top - sy) / sh);
    const width = Math.min(1 - x, rect.width / sw); const height = Math.min(1 - y, rect.height / sh);
    if (width <= 0 || height <= 0) return [];
    return [{ id: `element-${index}`, name, role, selector, rect: [x, y, width, height] as VisualRect }];
  }).sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3]).slice(0, 8);
}
