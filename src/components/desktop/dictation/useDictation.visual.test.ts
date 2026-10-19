// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDictation } from './useDictation';

class Recorder extends EventTarget {
  static isTypeSupported() { return true; }
  state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: ((event: { data: Blob }) => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recorded speech']) }); queueMicrotask(() => this.dispatchEvent(new Event('stop'))); }
}
let root: Root; let node: HTMLDivElement; let engine: ReturnType<typeof useDictation>;
const fetcher = vi.fn<typeof fetch>(); const stopTrack = vi.fn();
function Host() { engine = useDictation(); return null; }
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {
    state = 'running'; createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 256, smoothingTimeConstant: 0.6, getByteTimeDomainData() {} }; }
    async close() { this.state = 'closed'; }
  } });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(React.createElement(Host)));
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
it('delivers recognized visual instruction words without calling the rewrite endpoint', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ text: 'Keep the button exactly here.' }));
  const complete = vi.fn(); await act(async () => engine.start({ preserveTranscript: true, onComplete: complete }));
  await act(async () => engine.stopAndSubmit());
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/dictation/transcribe']);
  expect(complete).toHaveBeenCalledExactlyOnceWith('Keep the button exactly here.'); expect(stopTrack).toHaveBeenCalled();
});
it('cancelled transcription cannot publish words into a later capture', async () => {
  let resolve!: (response: Response) => void; fetcher.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const complete = vi.fn(); await act(async () => engine.start({ preserveTranscript: true, onComplete: complete }));
  let pending!: Promise<void>; await act(async () => { pending = engine.stopAndSubmit(); });
  await act(async () => engine.cancel());
  await act(async () => { resolve(Response.json({ text: 'Stale words.' })); await pending; });
  expect(complete).not.toHaveBeenCalled(); expect(engine.snapshot.state).toBe('idle'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('preserves the normal dictation polish path for other callers', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ text: 'Recognized words.' })).mockResolvedValueOnce(Response.json({ text: 'Polished words.' }));
  const complete = vi.fn(); await act(async () => engine.start({ onComplete: complete })); await act(async () => engine.stopAndSubmit());
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/dictation/transcribe', '/api/dictation/polish']);
  expect(complete).toHaveBeenCalledExactlyOnceWith('Polished words.');
});
