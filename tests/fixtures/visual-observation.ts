import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { VisualObservation } from '@/lib/composer/visual-inspection';

export async function visualObservation(): Promise<VisualObservation> {
  const clean = await sharp({ create: { width: 320, height: 280, channels: 4, background: '#202020' } }).png().toBuffer();
  const marked = await sharp(clean).composite([{ input: Buffer.from('<svg width="320" height="280"><rect x="40" y="50" width="240" height="170" fill="none" stroke="#ff5a1f" stroke-width="8"/></svg>') }]).png().toBuffer();
  return { id: 'mark-fixture', captureId: 'capture-fixture', generation: 1, revision: 1, frameAtMs: 100, markedAtMs: 150,
    timing: 'stream-receipt', sourcePtsMs: 1000, sourceHash: createHash('sha256').update(clean).digest('hex'),
    cleanHash: createHash('sha256').update(clean).digest('hex'), imageHash: createHash('sha256').update(marked).digest('hex'),
    width: 320, height: 280, sourceWidth: 320, sourceHeight: 280, crop: [0, 0, 1, 1], screen: [0, 0, 320, 280],
    cleanImage: { name: 'clean.png', dataUri: `data:image/png;base64,${clean.toString('base64')}` },
    image: { name: 'marked.png', dataUri: `data:image/png;base64,${marked.toString('base64')}` },
    strokes: [{ points: [{ x: 0.2, y: 0.2, tMs: 120 }, { x: 0.8, y: 0.8, tMs: 150 }] }] };
}
