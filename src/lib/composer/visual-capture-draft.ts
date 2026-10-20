import type { VisualSpeechFragment } from './visual-live-context';
import { renderVisualCapture } from './visual-capture-sequence';
import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from './visual-draft-store';
import type { VisualInstructionFrame } from './visual-instruction';
import { observationImageStrokes, type VisualElementCandidate, type VisualObservation } from './visual-inspection';

export interface VisualCaptureDraftState {
  id: string; draft: VisualInstructionDraft; atMs: number; nativeGeneration?: number; revision: number;
  observations: VisualObservation[]; liveSpeech?: VisualSpeechFragment[]; candidates: VisualElementCandidate[];
  baseWords: string; typed: string; spoken: string; wordsAt: number; markAt: number; rendering: number;
}
export function captureWords(capture: VisualCaptureDraftState) { return [capture.baseWords, capture.typed, capture.spoken].filter(Boolean).join('\n'); }
export function currentCaptureObservation(capture: VisualCaptureDraftState) {
  const observation = capture.observations.at(-1);
  return observation?.revision === capture.revision ? observation : null;
}

/** Prepare pixels without waiting for a model or a recording's final transcription. */
export async function saveCaptureSnapshot(capture: VisualCaptureDraftState, valid: () => boolean) {
  const observation = currentCaptureObservation(capture);
  if (!observation) throw new Error('The latest mark has no ready pixels yet. Its recording is retained.');
  const rendering = ++capture.rendering;
  let frame: VisualInstructionFrame = { id: capture.id, atMs: capture.atMs, transcript: capture.spoken.slice(0, 8000), image: observation.image,
    width: observation.width, height: observation.height, strokes: observationImageStrokes(observation), pins: [], ...(capture.liveSpeech?.length ? { liveSpeech: capture.liveSpeech } : {}), observation, candidates: capture.candidates };
  if (capture.observations.length > 1) {
    const sheet = await renderVisualCapture({ durationMs: observation.markedAtMs, instruction: '', directory: '', frames: capture.observations.map(item => ({
      atMs: item.markedAtMs, kind: 'mark', width: item.width, height: item.height, dataUri: item.image.dataUri, file: '',
    })) });
    frame = { ...frame, width: sheet.width, height: sheet.height, image: { name: 'visual-capture.jpg', dataUri: sheet.dataUri }, strokes: [], sequence: sheet.sequence };
  }
  if (!valid() || rendering !== capture.rendering || currentCaptureObservation(capture) !== observation) return null;
  const stored = readVisualDraft(capture.draft.principal, capture.draft.request.target);
  if (stored && (stored.request.id !== capture.draft.request.id || stored.status !== 'draft')) return null;
  const draft = stored ?? capture.draft;
  const utterance = captureWords(capture);
  if (utterance.length > 16_000) throw new Error('The instruction exceeds the chat limit. Shorten it in the composer before sending.');
  const frames = draft.request.frames.some(item => item.id === capture.id)
    ? draft.request.frames.map(item => item.id === capture.id ? frame : item) : [...draft.request.frames, frame];
  const updated: VisualInstructionDraft = { ...draft, inspectionReadyAt: Math.max(capture.markAt, capture.wordsAt), error: undefined,
    request: { ...draft.request, clarification: undefined, utterance, frames } };
  capture.draft = updated;
  await saveVisualDraft(updated);
  return updated;
}
