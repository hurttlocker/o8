// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { captureMomentTranscripts, parseVisualCaptureSequence, renderVisualCapture, type NativeVisualCapture } from './visual-capture-sequence';
import { parseVisualInstruction, buildVisualInstructionPayload } from './visual-instruction';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const capture: NativeVisualCapture = { durationMs: 8_000, directory: '/private/capture-owned', instruction: 'Keep the labels aligned.', frames: [
  { atMs: 1_000, kind: 'mark', width: 800, height: 600, dataUri: png, file: '/private/capture-owned/frame-01.png' },
  { atMs: 6_000, kind: 'change', width: 800, height: 600, dataUri: png, file: '/private/capture-owned/frame-02.png' },
] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function installCaptureCanvas() {
  vi.stubGlobal('Image', class {
    naturalWidth = 800; naturalHeight = 600; src = '';
    decode = vi.fn(async () => {});
  });
  const context = { fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/2Q==');
  return context;
}

it('renders the numbered native sequence and preserves measured narration in the wire carrier', async () => {
  const context = installCaptureCanvas();
  const result = await renderVisualCapture(capture, [{ t0: 0, t1: 1_000, text: 'Make this smaller.' }, { t0: 4_000, t1: 5_000, text: 'Align this label.' }], 500);
  expect(context.drawImage).toHaveBeenCalledTimes(2);
  expect(context.fillText.mock.calls.map(call => call[0])).toEqual(['01   0:01', '02   0:06']);
  expect(result.sequence.moments.map(moment => moment.transcript)).toEqual(['Make this smaller.', 'Align this label.']);
  expect(result.sequence.timing).toBe('audio');
  const request = parseVisualInstruction({ version: 1, id: 'request-owned', createdAt: '2026-10-19T00:00:00Z', target: { threadId: 'same-chat', repoPath: '/project' }, utterance: capture.instruction,
    frames: [{ id: 'frame-owned', atMs: 0, transcript: 'Make this smaller. Align this label.', image: { name: 'capture.jpg', dataUri: result.dataUri }, width: result.width, height: result.height, strokes: [], pins: [], sequence: result.sequence }] });
  expect(request).not.toBeNull();
  const wire = buildVisualInstructionPayload(request!).wireMessage;
  expect(wire).toContain('Make this smaller.'); expect(wire).toContain('Align this label.');
  expect(wire).toContain('/private/capture-owned'); expect(wire).toContain('same-chat');
});

it('keeps an untimed fallback honest rather than inventing word timestamps', async () => {
  installCaptureCanvas();
  const result = await renderVisualCapture(capture);
  expect(result.sequence.timing).toBe('capture');
  expect(result.sequence.moments.every(moment => moment.transcript === '')).toBe(true);
  expect(captureMomentTranscripts([1_000, 5_000], [{ t0: 0, t1: 500, text: 'Second screen' }], 4_000)).toEqual(['', 'Second screen']);
});

it('rejects a corrupt frame before saving a false contact sheet', async () => {
  installCaptureCanvas();
  await expect(renderVisualCapture({ ...capture, frames: [{ ...capture.frames[0], width: 900 }] })).rejects.toThrow('pixels do not match');
});

it('rejects reversed chronology, out of bounds sheet regions, and oversized combined speech', async () => {
  const moment = { n: 1, atMs: 1_000, kind: 'mark', rect: [0, 0, 1, 1], transcript: '' };
  const value = { durationMs: 8_000, timing: 'audio', moments: [moment] };
  expect(parseVisualCaptureSequence(value)).not.toBeNull();
  expect(parseVisualCaptureSequence({ ...value, moments: [{ ...moment, rect: [0.8, 0, 0.4, 1] }] })).toBeNull();
  expect(parseVisualCaptureSequence({ ...value, moments: [moment, { ...moment, n: 2, atMs: 500 }] })).toBeNull();
  expect(parseVisualCaptureSequence({ ...value, moments: [1, 2, 3].map(n => ({ ...moment, n, transcript: 'a'.repeat(6_000) })) })).toBeNull();
});
