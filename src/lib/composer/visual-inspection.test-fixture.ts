import type { VisualObservation } from './visual-inspection';
const observation: VisualObservation = {
  id: 'mark-a', captureId: 'capture-a', generation: 7, revision: 1,
  frameAtMs: 100, markedAtMs: 180, timing: 'stream-receipt', sourcePtsMs: 900,
  sourceHash: 'a'.repeat(64), imageHash: 'b'.repeat(64), cleanHash: 'c'.repeat(64),
  width: 320, height: 280, sourceWidth: 1280, sourceHeight: 800,
  crop: [0.1, 0.2, 0.4, 0.5], screen: [100, 50, 1280, 800],
  image: { name: 'mark.png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' },
  cleanImage: { name: 'clean.png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' },
  strokes: [{ points: [{ x: 0.2, y: 0.3, tMs: 150 }, { x: 0.4, y: 0.5, tMs: 180 }] }],
};

export const sampleObservation = () => structuredClone(observation);
