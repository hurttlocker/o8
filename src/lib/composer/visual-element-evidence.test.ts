// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { snapshotVisualElements, visualElementCandidates } from './visual-element-evidence';
import { sampleObservation } from './visual-inspection.test-fixture';
afterEach(() => { document.body.replaceChildren(); Reflect.deleteProperty(document, 'elementFromPoint'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('resolves a real local button from source-screen geometry and discards identities after scrolling', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.stubGlobal('CSS', { escape: (text: string) => text });
  vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800);
  const button = document.createElement('button'); button.id = 'actual-button'; button.setAttribute('aria-label', 'Adjust size'); document.body.append(button);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => button });
  const hidden = document.createElement('button'); hidden.textContent = 'Hidden duplicate'; hidden.style.visibility = 'hidden'; document.body.append(hidden);
  vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue({ left: 120, top: 120, width: 100, height: 40, right: 220, bottom: 160 } as DOMRect);
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 120, top: 120, width: 100, height: 40, right: 220, bottom: 160 } as DOMRect);
  await Promise.resolve();
  const snapshot = snapshotVisualElements();
  const observation = { ...sampleObservation(), screen: [0, 0, 1000, 800] as [number, number, number, number], webviewRect: [0, 0, 1000, 800] as [number, number, number, number],
    strokes: [{ points: [{ x: 0.1, y: 0.1, tMs: 150 }, { x: 0.3, y: 0.3, tMs: 180 }] }] };
  expect(visualElementCandidates(snapshot, observation)).toEqual([{ id: 'element-0', name: 'Adjust size', role: 'button', selector: '#actual-button', rect: [0.12, 0.15, 0.1, 0.05] }]);
  window.dispatchEvent(new Event('scroll'));
  expect(visualElementCandidates(snapshot, observation)).toEqual([]);
  expect(visualElementCandidates(snapshot, { ...observation, webviewRect: undefined })).toEqual([]);
});
