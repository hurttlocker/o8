import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';

export type VisualRect = [number, number, number, number];
export interface VisualObservation {
  id: string; captureId: string; generation: number; revision: number;
  frameAtMs: number; preparedAtMs?: number; validThroughMs?: number; markedAtMs: number; timing: 'stream-receipt'; sourcePtsMs: number;
  sourceHash: string; imageHash: string; cleanHash: string;
  width: number; height: number; sourceWidth: number; sourceHeight: number;
  crop: VisualRect; screen: VisualRect; contentRect?: VisualRect; webviewRect?: VisualRect;
  image: { name: string; dataUri: string }; cleanImage: { name: string; dataUri: string };
  strokes: Array<{ points: Array<{ x: number; y: number; tMs: number }> }>;
}
export interface VisualElementCandidate {
  id: string; name: string; role: string; rect: VisualRect; selector?: string;
}
export interface VisualInspectionInput {
  principal: string; requestId: string; observation: VisualObservation;
  utterance: string; candidates: VisualElementCandidate[];
}
export interface VisualInspectionResult {
  key: string; status: 'observed' | 'unavailable'; receiptId?: string; model?: string; latencyMs?: number;
  target?: string; ambiguity?: 'none' | 'target' | 'change' | 'unknown';
  /** These judgments are advisory, never permission or a submission decision. */
  confidence?: number; targetVisible?: number; reason?: string;
}
export const VISUAL_INSPECTION_BUDGET_MS = 1_000;

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const integer = (v: unknown, max: number): v is number => bounded(v, max) && Number.isInteger(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function rect(v: unknown): v is VisualRect {
  return Array.isArray(v) && v.length === 4 && v.every(n => bounded(n, 1))
    && v[2] > 0 && v[3] > 0 && v[0] + v[2] <= 1.00001 && v[1] + v[3] <= 1.00001;
}

export function parseVisualObservation(v: unknown): VisualObservation | null {
  if (!object(v) || !text(v.id, 96) || !text(v.captureId, 96) || !integer(v.generation, Number.MAX_SAFE_INTEGER)
    || !integer(v.revision, 128) || v.revision < 1 || v.timing !== 'stream-receipt'
    || (v.preparedAtMs !== undefined && (!bounded(v.preparedAtMs, 90_000) || !bounded(v.markedAtMs, v.preparedAtMs)))
    || !bounded(v.frameAtMs, 90_000) || !bounded(v.markedAtMs, 90_000) || v.frameAtMs > v.markedAtMs
    || (v.validThroughMs !== undefined && (!bounded(v.validThroughMs, v.markedAtMs) || v.validThroughMs < v.frameAtMs))
    || v.markedAtMs - (typeof v.validThroughMs === 'number' ? v.validThroughMs : v.frameAtMs) > 250 || !bounded(v.sourcePtsMs, Number.MAX_SAFE_INTEGER)
    || !hash(v.sourceHash) || !hash(v.imageHash) || !hash(v.cleanHash)
    || !integer(v.width, 1568) || !integer(v.height, 1568) || v.width < 280 || v.height < 280
    || !integer(v.sourceWidth, 32_768) || !integer(v.sourceHeight, 32_768) || v.sourceWidth < 1 || v.sourceHeight < 1
    || !rect(v.crop) || (v.contentRect !== undefined && !rect(v.contentRect))
    || !Array.isArray(v.screen) || v.screen.length !== 4 || v.screen.some(n => typeof n !== 'number' || !Number.isFinite(n))
    || v.screen[2] <= 0 || v.screen[3] <= 0 || v.screen[2] > 32_768 || v.screen[3] > 32_768
    || (v.webviewRect !== undefined && (!Array.isArray(v.webviewRect) || v.webviewRect.length !== 4 || v.webviewRect.some(n => typeof n !== 'number' || !Number.isFinite(n)) || v.webviewRect[2] <= 0 || v.webviewRect[3] <= 0))
    || !object(v.image) || !object(v.cleanImage) || !text(v.image.name, 500) || !text(v.cleanImage.name, 500)
    || !Array.isArray(v.strokes) || v.strokes.length < 1 || v.strokes.length > 128) return null;
  let images;
  try { images = validateComposerImageAttachments([v.image, v.cleanImage]); } catch { return null; }
  if (images.some(image => !image.dataUri.startsWith('data:image/png;base64,'))) return null;
  let count = 0;
  const strokes: VisualObservation['strokes'] = [];
  for (const stroke of v.strokes) {
    if (!object(stroke) || !Array.isArray(stroke.points) || !stroke.points.length) return null;
    const points: VisualObservation['strokes'][number]['points'] = [];
    for (const p of stroke.points) {
      if (++count > 8_192 || !object(p) || !bounded(p.x, 1) || !bounded(p.y, 1) || !bounded(p.tMs, v.markedAtMs)) return null;
      points.push({ x: p.x, y: p.y, tMs: p.tMs });
    }
    strokes.push({ points });
  }
  return { id: v.id, captureId: v.captureId, generation: v.generation, revision: v.revision,
    frameAtMs: v.frameAtMs, ...(typeof v.preparedAtMs === 'number' ? { preparedAtMs: v.preparedAtMs } : {}), ...(typeof v.validThroughMs === 'number' ? { validThroughMs: v.validThroughMs } : {}), markedAtMs: v.markedAtMs, timing: v.timing, sourcePtsMs: v.sourcePtsMs,
    sourceHash: v.sourceHash, imageHash: v.imageHash, cleanHash: v.cleanHash,
    width: v.width, height: v.height, sourceWidth: v.sourceWidth, sourceHeight: v.sourceHeight,
    crop: [...v.crop], screen: [...v.screen] as VisualRect, ...(v.contentRect ? { contentRect: [...v.contentRect] as VisualRect } : {}),
    ...(v.webviewRect ? { webviewRect: [...v.webviewRect] as VisualRect } : {}),
    image: { name: v.image.name, dataUri: images[0].dataUri }, cleanImage: { name: v.cleanImage.name, dataUri: images[1].dataUri }, strokes };
}

export function parseVisualCandidates(v: unknown): VisualElementCandidate[] | null {
  if (!Array.isArray(v) || v.length > 8) return null;
  const result: VisualElementCandidate[] = [];
  for (const candidate of v) {
    if (!object(candidate) || !text(candidate.id, 96) || !text(candidate.name, 180) || !text(candidate.role, 40)
      || !rect(candidate.rect) || (candidate.selector !== undefined && !text(candidate.selector, 500))
      || result.some(item => item.id === candidate.id) || ['none', 'ambiguous', 'marked-region'].includes(candidate.id)) return null;
    result.push({ id: candidate.id, name: candidate.name, role: candidate.role, rect: [...candidate.rect],
      ...(typeof candidate.selector === 'string' ? { selector: candidate.selector } : {}) });
  }
  return result;
}

export function inspectionKey(input: VisualInspectionInput): string {
  const frame = input.observation;
  return JSON.stringify([input.principal, input.requestId, frame.captureId, frame.generation,
    frame.id, frame.revision, frame.sourceHash, frame.imageHash, frame.cleanHash, input.utterance, input.candidates]);
}

/** Never duplicate image bytes or let untrusted advisory output change the route. */
export function observationEvidence(observation: VisualObservation) {
  const { image: _image, cleanImage: _clean, ...evidence } = observation;
  return { ...evidence, coordinateSpace: 'source-screen-normalized', imageTransform: 'crop-then-content-rect' };
}

export function observationImageStrokes(observation: VisualObservation) {
  const [left, top, width, height] = observation.crop;
  const [x, y, w, h] = observation.contentRect ?? [0, 0, 1, 1];
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return observation.strokes.map(stroke => ({ points: stroke.points.map(point => ({ ...point,
    x: clamp(x + (point.x - left) / width * w), y: clamp(y + (point.y - top) / height * h),
  })) }));
}
