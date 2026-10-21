import { createHash } from 'node:crypto';

export interface JudgmentImageAsset { type: 'image'; format: 'png'; data_base64: string }
export type JudgmentImageAssets = Record<string, JudgmentImageAsset>;

/** Bound the bytes and decoded dimensions before forwarding any screen image. */
export function inspectPng(dataUri: string) {
  const match = /^data:image\/png;base64,([a-z\d+/]+={0,2})$/i.exec(dataUri);
  if (!match || dataUri.length > 2_000_000) throw new Error('Expected a bounded PNG image.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1] || bytes.length < 33
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG image.');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (width < 280 || height < 280 || width > 1568 || height > 1568) throw new Error('Inspection images must be 280 to 1568 pixels per side.');
  return { width, height, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'),
    asset: { type: 'image', format: 'png', data_base64: match[1] } as JudgmentImageAsset };
}

export function validateJudgmentAssets(assets: JudgmentImageAssets): boolean {
  const entries = Object.entries(assets);
  if (entries.length < 1 || entries.length > 2) return false;
  let total = 0;
  try {
    for (const [id, asset] of entries) {
      if (!/^[a-z\d-]{16,96}$/i.test(id) || asset.type !== 'image' || asset.format !== 'png') return false;
      total += inspectPng(`data:image/png;base64,${asset.data_base64}`).bytes;
    }
  } catch { return false; }
  return total <= 1_500_000;
}
