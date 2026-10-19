import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import type { TimedDictationWord } from '@/components/desktop/dictation/types';

export interface VisualCaptureMoment {
  n: number; atMs: number; kind: 'mark' | 'click' | 'change' | 'view';
  rect: [number, number, number, number]; transcript: string;
}
export interface VisualCaptureSequence {
  durationMs: number; timing: 'audio' | 'capture'; moments: VisualCaptureMoment[]; sourceDirectory?: string;
}
export interface NativeVisualCapture {
  durationMs: number; instruction: string; directory: string;
  frames: Array<{ atMs: number; kind: VisualCaptureMoment['kind']; width: number; height: number; dataUri: string; file: string }>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 90_000;
export function parseVisualCaptureSequence(value: unknown): VisualCaptureSequence | null {
  if (!record(value) || !time(value.durationMs) || !['audio', 'capture'].includes(String(value.timing)) || !Array.isArray(value.moments) || !value.moments.length || value.moments.length > 12) return null;
  if (value.sourceDirectory !== undefined && (typeof value.sourceDirectory !== 'string' || value.sourceDirectory.length > 4096 || /[\r\n\0]/.test(value.sourceDirectory))) return null;
  const moments: VisualCaptureMoment[] = [];
  let transcriptLength = 0;
  for (const [index, item] of value.moments.entries()) {
    if (!record(item) || item.n !== index + 1 || !time(item.atMs) || item.atMs > value.durationMs || !['mark', 'click', 'change', 'view'].includes(String(item.kind))
      || typeof item.transcript !== 'string' || item.transcript.length > 8_000 || !Array.isArray(item.rect) || item.rect.length !== 4
      || item.rect.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
      || item.rect[2] <= 0 || item.rect[3] <= 0 || item.rect[0] + item.rect[2] > 1.00001 || item.rect[1] + item.rect[3] > 1.00001
      || moments.length > 0 && item.atMs < moments[moments.length - 1].atMs) return null;
    moments.push({ n: item.n as number, atMs: item.atMs, kind: item.kind as VisualCaptureMoment['kind'], rect: item.rect as VisualCaptureMoment['rect'], transcript: item.transcript });
    transcriptLength += item.transcript.length;
    if (transcriptLength > 16_000) return null;
  }
  return { durationMs: value.durationMs, timing: value.timing as VisualCaptureSequence['timing'], moments, ...(value.sourceDirectory ? { sourceDirectory: value.sourceDirectory as string } : {}) };
}

export function captureSheetLayout(frames: Array<{ width: number; height: number }>) {
  const columns = frames.length === 1 ? 1 : 2;
  const cellWidth = frames.length === 1 ? 800 : 640;
  const gap = 16; const header = 36; const imageHeight = 360;
  const width = gap + columns * (cellWidth + gap);
  const height = gap + Math.ceil(frames.length / columns) * (header + imageHeight + gap);
  return { width, height, cells: frames.map((frame, index) => {
    const scale = Math.min(cellWidth / frame.width, imageHeight / frame.height);
    const w = frame.width * scale; const h = frame.height * scale;
    const left = gap + index % columns * (cellWidth + gap);
    const top = gap + Math.floor(index / columns) * (header + imageHeight + gap);
    return { left, top, width: cellWidth, height: header + imageHeight, image: { left: left + (cellWidth - w) / 2, top: top + header + (imageHeight - h) / 2, width: w, height: h } };
  }) };
}

/** Exact audio word ranges can be grouped; an untimed fallback stays a single original transcript. */
export function captureMomentTranscripts(times: number[], words: TimedDictationWord[] | undefined, offsetMs: number): string[] {
  const values = times.map(() => [] as string[]);
  for (const word of words ?? []) {
    const at = offsetMs + (word.t0 + word.t1) / 2;
    let index = times.findIndex((time, n) => n < times.length - 1 && at < (time + times[n + 1]) / 2);
    if (index < 0) index = times.length - 1;
    if (index >= 0) values[index].push(word.text);
  }
  return values.map(value => value.join(' '));
}

export async function renderVisualCapture(capture: NativeVisualCapture, words?: TimedDictationWord[], voiceOffsetMs = 0) {
  if (!time(capture.durationMs) || !capture.frames.length || capture.frames.length > 12 || typeof capture.instruction !== 'string' || capture.instruction.length > 16_000) throw new Error('The captured sequence is invalid. Keep the recording and capture again.');
  const layout = captureSheetLayout(capture.frames);
  const canvas = document.createElement('canvas'); canvas.width = layout.width; canvas.height = layout.height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('The visual contact sheet could not be rendered.');
  context.fillStyle = '#141414'; context.fillRect(0, 0, canvas.width, canvas.height);
  const transcripts = captureMomentTranscripts(capture.frames.map(frame => frame.atMs), words, voiceOffsetMs);
  const moments: VisualCaptureMoment[] = [];
  // Decode one source at a time instead of retaining twelve full-resolution bitmaps.
  for (const [index, frame] of capture.frames.entries()) {
    if (!time(frame.atMs) || frame.atMs > capture.durationMs || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 32_768 || frame.height > 32_768) throw new Error('Invalid captured frame geometry.');
    const [attachment] = validateComposerImageAttachments([{ name: 'capture.png', dataUri: frame.dataUri }]);
    const image = new Image(); image.src = attachment.dataUri; await image.decode();
    if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new Error('Captured pixels do not match their dimensions.');
    const cell = layout.cells[index];
    context.fillStyle = '#202020'; context.fillRect(cell.left, cell.top, cell.width, cell.height);
    context.fillStyle = '#e4e4e7'; context.font = '300 18px -apple-system, BlinkMacSystemFont, sans-serif'; context.textBaseline = 'middle';
    const seconds = Math.floor(frame.atMs / 1000);
    context.fillText(`${String(index + 1).padStart(2, '0')}   ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, cell.left + 12, cell.top + 18);
    context.drawImage(image, cell.image.left, cell.image.top, cell.image.width, cell.image.height);
    moments.push({ n: index + 1, atMs: frame.atMs, kind: frame.kind, transcript: transcripts[index], rect: [cell.image.left / layout.width, cell.image.top / layout.height, cell.image.width / layout.width, cell.image.height / layout.height] });
    image.src = '';
  }
  const sequence = parseVisualCaptureSequence({ durationMs: capture.durationMs, timing: words?.length ? 'audio' : 'capture', moments, sourceDirectory: capture.directory });
  if (!sequence) throw new Error('The captured timeline is invalid.');
  const dataUri = canvas.toDataURL('image/jpeg', 0.88);
  validateComposerImageAttachments([{ name: 'visual-capture.jpg', dataUri }]);
  return { dataUri, width: canvas.width, height: canvas.height, sequence, instruction: capture.instruction };
}
