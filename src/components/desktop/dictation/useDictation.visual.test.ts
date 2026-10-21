// @vitest-environment jsdom
import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDictation } from './useDictation';
import { captureMicrophone } from '@/lib/voice/microphone-input';

class Recorder extends EventTarget {
  static isTypeSupported() { return true; }
  state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: ((event: { data: Blob }) => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recorded speech']) }); queueMicrotask(() => this.dispatchEvent(new Event('stop'))); }
}
let root: Root; let node: HTMLDivElement; let engine: ReturnType<typeof useDictation>;
const fetcher = vi.fn<typeof fetch>(); const stopTrack = vi.fn();
function Host() { const current = useDictation(); useLayoutEffect(() => { engine = current; }); return null; }
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
afterEach(async () => { await act(async () => root.unmount()); node.remove(); Reflect.deleteProperty(window, 'SpeechRecognition'); vi.unstubAllGlobals(); });
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
it.each(['stop', 'cancel'])('keeps input reserved until the partial recognizer ends on %s', async action => {
  const recognizers: { onend: (() => void) | null; abort: ReturnType<typeof vi.fn> }[] = [];
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: class {
    onend: (() => void) | null = null; abort = vi.fn(); start() {} stop() {}
    constructor() { recognizers.push(this); }
  } });
  let finish!: (response: Response) => void;
  fetcher.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => engine.start({ preserveTranscript: true, onComplete: vi.fn() }));
  const recognizer = recognizers[0];
  let pending: Promise<void> | undefined;
  await act(async () => { if (action === 'stop') pending = engine.stopAndSubmit(); else engine.cancel(); });
  expect(recognizer.abort).toHaveBeenCalledOnce(); expect(stopTrack).toHaveBeenCalledOnce();
  await expect(captureMicrophone({ audio: true })).rejects.toThrow('Another voice input is active');
  await act(async () => recognizer.onend?.());
  const next = await captureMicrophone({ audio: true }); await next.stop();
  if (pending) await act(async () => { finish(Response.json({ text: 'Earlier recording.' })); await pending; });
});
