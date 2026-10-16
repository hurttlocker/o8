import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import type { PrFile } from './types';

// Git C quoting preserves spaces, control characters, quotes and UTF-8 paths.
function quotePath(path: string): string {
  return '"' + Array.from(new TextEncoder().encode(path), (byte) => {
    if (byte === 34 || byte === 92) return '\\' + String.fromCharCode(byte);
    return byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0');
  }).join('') + '"';
}

export function parsePrFilePatch(file: Pick<PrFile, 'path' | 'previousPath' | 'status' | 'patch'>): FileDiffMetadata {
  if (!file.patch?.startsWith('@@ ')) throw new Error('A unified file patch is required.');
  const oldPath = file.previousPath || file.path;
  const headers = [`diff --git ${quotePath('a/' + oldPath)} ${quotePath('b/' + file.path)}`];
  headers.push('--- ' + (file.status === 'added' ? '/dev/null' : quotePath('a/' + oldPath)), '+++ ' + (file.status === 'removed' ? '/dev/null' : quotePath('b/' + file.path)));
  // No statistics-based cache key: content changes, even with equal counts,
  // must produce new metadata and highlighted rows.
  const patches = parsePatchFiles(headers.join('\n') + '\n' + file.patch + '\n', undefined, true);
  const diff = patches[0]?.files[0];
  if (patches.length !== 1 || patches[0].files.length !== 1 || !diff?.hunks.length) throw new Error('The supplied patch is incomplete.');
  // GitHub supplies change kind separately, without Git's similarity/mode
  // headers. Preserve that verified metadata without inventing either value.
  if (file.status === 'added') diff.type = 'new';
  else if (file.status === 'removed') diff.type = 'deleted';
  else if (file.previousPath) { diff.type = 'rename-changed'; diff.prevName = file.previousPath; }
  return diff;
}
