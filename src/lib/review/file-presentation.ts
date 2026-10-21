export type ReviewFileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary' | 'directory' | 'symlink';
export type ReviewDiffStatus = 'ready' | 'empty' | 'binary' | 'directory' | 'too_large' | 'truncated';
export interface ReviewFilePresentation { kind?: ReviewFileKind; size?: number; diffStatus?: ReviewDiffStatus }
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp']);
const VIDEOS = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const BINARY = new Set(['bin', 'zip', 'gz', 'tar', '7z', 'dmg', 'exe', 'dll', 'so', 'wasm', 'woff', 'woff2', 'ttf', 'otf', 'sqlite', 'db', 'psd', 'sketch', 'heic', 'heif', 'parquet', 'xlsx', 'docx', 'pptx']);

export function reviewFileKind(path: string): ReviewFileKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGES.has(ext) ? 'image' : VIDEOS.has(ext) ? 'video' : AUDIO.has(ext) ? 'audio' : ext === 'pdf' ? 'pdf' : BINARY.has(ext) ? 'binary' : 'text';
}
export function reviewFileSize(bytes?: number): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function isBinaryPatch(patch: string): boolean { return /^(?:Binary files |GIT binary patch)/m.test(patch); }
export function isDirectoryPatch(patch: string): boolean { return /^(?:[+-]Subproject commit |(?:new|deleted) file mode 160000)/m.test(patch); }
