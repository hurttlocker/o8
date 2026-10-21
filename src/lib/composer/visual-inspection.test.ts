import { sampleObservation } from './visual-inspection.test-fixture';
import { describe, expect, it } from 'vitest';
import { inspectionKey, parseVisualObservation, observationEvidence } from './visual-inspection';

const observation = sampleObservation();

describe('visual observation ownership and provenance', () => {
  it('retains clean pixels separately from marks and preserves the original coordinate transform', () => {
    expect(parseVisualObservation(observation)).toEqual(observation);
    const evidence = observationEvidence(observation);
    expect(evidence).not.toHaveProperty('image');
    expect(evidence).not.toHaveProperty('cleanImage');
    expect(evidence).toMatchObject({ id: 'mark-a', sourceHash: 'a'.repeat(64), crop: observation.crop, timing: 'stream-receipt' });
  });

  it.each([
    { frameAtMs: 200 }, { markedAtMs: 700 }, { crop: [0.9, 0, 0.5, 1] },
    { generation: -1 }, { revision: 0 }, { sourceHash: 'invented' },
    { width: 1569 }, { screen: [0, 0, 0, 800] }, { sourcePtsMs: Number.NaN },
  ])('rejects invalid or stale snapshot geometry: %j', patch => {
    expect(parseVisualObservation({ ...observation, ...patch })).toBeNull();
  });

  it('rejects strokes whose event time belongs to a different mark', () => {
    expect(parseVisualObservation({ ...observation, strokes: [{ points: [{ x: 0.3, y: 0.3, tMs: 181 }] }] })).toBeNull();
  });

  it('changes the inspection identity when words, pixels, account or candidate geometry change', () => {
    const input = { principal: 'person-a', requestId: 'request-a', observation, utterance: 'Make this smaller.', candidates: [] };
    const key = inspectionKey(input);
    expect(inspectionKey({ ...input })).toBe(key);
    expect(inspectionKey({ ...input, principal: 'person-b' })).not.toBe(key);
    expect(inspectionKey({ ...input, utterance: 'Keep the size.' })).not.toBe(key);
    expect(inspectionKey({ ...input, observation: { ...observation, imageHash: 'd'.repeat(64) } })).not.toBe(key);
    expect(inspectionKey({ ...input, candidates: [{ id: 'button-a', name: 'Show', role: 'button', rect: [0, 0, 1, 1], selector: '#show' }] })).not.toBe(key);
  });
});

it('transforms source stroke coordinates through the exact crop and padding used by the attached pixels', async () => {
  const { observationImageStrokes } = await import('./visual-inspection');
  const source = { ...sampleObservation(), contentRect: [0.1, 0.2, 0.8, 0.6] as [number, number, number, number] };
  const point = observationImageStrokes(source)[0].points[0];
  expect(point.x).toBeCloseTo(0.3); expect(point.y).toBeCloseTo(0.32); expect(point.tMs).toBe(150);
  expect(source.strokes[0].points[0]).toEqual({ x: 0.2, y: 0.3, tMs: 150 });
});
