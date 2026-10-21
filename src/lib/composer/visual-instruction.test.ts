import { describe, expect, it } from 'vitest';
import { buildVisualInstructionPayload, parseVisualInstruction, visualInstructionScope } from './visual-instruction';

const image = { name: 'marked.png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' };
const request = () => ({
  version: 1, id: 'visual-1', createdAt: '2026-10-19T12:00:00.000Z',
  target: { threadId: 'thoughts-a', repoPath: '/project' }, utterance: 'Keep this button here.',
  frames: [{ id: 'frame-1', atMs: 0, width: 800, height: 600, transcript: 'Keep this button here.', image,
    strokes: [{ points: [{ x: 0.25, y: 0.5, tMs: 0 }, { x: 0.75, y: 0.5, tMs: 120 }] }],
    pins: [{ n: 1, x: 0.5, y: 0.5, text: 'Keep this' }] }],
});

describe('visual instructions preserve the user evidence and conversation', () => {
  it('keeps the original words, normalized marks and frame order in the outgoing payload', () => {
    const original = request();
    original.frames.push({ ...original.frames[0], id: 'frame-2', atMs: 1250, transcript: 'Then move this one.' });
    const result = buildVisualInstructionPayload(original);
    expect(result.text).toBe(original.utterance);
    expect(result.images).toEqual([image, image]);
    expect(result.wireMessage).toContain(original.utterance);
    expect(result.wireMessage).toContain('Then move this one.');
    expect(result.wireMessage).toContain('0.25');
    expect(result.wireMessage).not.toContain(image.dataUri);
    expect(result.evidence.frames.map(frame => frame.imageIndex)).toEqual([0, 1]);
    expect(original).toEqual(requestWithTwoFrames());
  });

  it('rejects missing pixels, invalid geometry, too many frames and authority patches', () => {
    const original = request();
    expect(parseVisualInstruction({ ...original, frames: [{ ...original.frames[0], image: undefined }] })).toBeNull();
    expect(parseVisualInstruction({ ...original, frames: [{ ...original.frames[0], width: 0 }] })).toBeNull();
    expect(parseVisualInstruction({ ...original, frames: [{ ...original.frames[0], strokes: [{ points: [{ x: 2, y: 0, tMs: 0 }] }] }] })).toBeNull();
    expect(parseVisualInstruction({ ...original, frames: Array.from({ length: 5 }, (_, index) => ({ ...original.frames[0], id: `frame-${index}` })) })).toBeNull();
    expect(parseVisualInstruction({ ...original, clarification: { path: 'authority.write', value: 'yes' } })).toBeNull();
  });

  it('treats another chat or repository as a different destination', () => {
    const target = request().target;
    expect(visualInstructionScope(target)).not.toBe(visualInstructionScope({ ...target, threadId: 'thoughts-b' }));
    expect(visualInstructionScope(target)).not.toBe(visualInstructionScope({ ...target, repoPath: '/other' }));
  });

  it('keeps confirmed intent bounded and distinct from original words', () => {
    const original = request();
    const parsed = parseVisualInstruction({ ...original, clarification: { path: 'intent.target', value: 'button', question: 'Which control?' } });
    expect(parsed?.utterance).toBe(original.utterance);
    expect(buildVisualInstructionPayload(parsed!).wireMessage).toContain('intent.target');
    expect(buildVisualInstructionPayload(parsed!).wireMessage).toContain('do not expand authority');
  });
});

function requestWithTwoFrames() {
  const value = request();
  value.frames.push({ ...value.frames[0], id: 'frame-2', atMs: 1250, transcript: 'Then move this one.' });
  return value;
}

it('restores a marked draft before any words are typed, but cannot submit it', () => {
  const draft = { ...request(), utterance: '' };
  expect(parseVisualInstruction(draft, true)?.frames).toHaveLength(1);
  expect(parseVisualInstruction(draft)).toBeNull();
});
it('retains typed words after the last frame is removed without allowing a pixel-free send', () => {
  const draft = { ...request(), frames: [] };
  expect(parseVisualInstruction(draft, true)?.utterance).toBe(draft.utterance);
  expect(parseVisualInstruction(draft)).toBeNull();
});
it('bounds dense wire metadata while retaining every original point and actual image', () => {
  const original = request();
  original.frames[0].strokes = [{ points: Array.from({ length: 8192 }, (_, tMs) => ({ x: tMs / 8192, y: 0.5, tMs })) }];
  const result = buildVisualInstructionPayload(original);
  expect(result.evidence.frames[0].strokes[0].points.length).toBeLessThanOrEqual(514);
  expect(result.evidence.frames[0]).toMatchObject({ strokesSampled: true, originalPointCount: 8192 });
  expect(result.wireMessage.length).toBeLessThan(100_000);
  expect(original.frames[0].strokes[0].points).toHaveLength(8192);
  expect(result.images[0]).toEqual(image);
});

it('refuses a mismatched attachment while preserving a paired observation without embedding clean pixels in wire text', async () => {
  const { sampleObservation } = await import('./visual-inspection.test-fixture');
  const observation = sampleObservation(); const value = request();
  const frame = { ...value.frames[0], width: observation.width, height: observation.height, image: observation.image, observation };
  expect(parseVisualInstruction({ ...value, frames: [frame] })).not.toBeNull();
  expect(parseVisualInstruction({ ...value, frames: [{ ...frame, image: { ...frame.image, dataUri: 'data:image/png;base64,YQ==' } }] })).toBeNull();
  const result = buildVisualInstructionPayload({ ...value, frames: [frame] });
  expect(result.images[0].dataUri).toBe(observation.image.dataUri);
  expect(result.wireMessage).not.toContain('data:image');
});
