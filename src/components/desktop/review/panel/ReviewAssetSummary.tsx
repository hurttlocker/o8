import type { ReviewFilePresentation } from '@/lib/review/file-presentation';
import { reviewFileSize } from '@/lib/review/file-presentation';
import { FileCode, Image as ImageIcon, Play, Folder, Volume2 } from '../../lucide-shims';
import { UI_FONT } from './constants';

export function ReviewAssetSummary({ presentation, path, repoPath, deleted, error, historical = false }: {
  presentation: ReviewFilePresentation; path: string; repoPath: string; deleted?: boolean; error?: string | null; historical?: boolean;
}) {
  const kind = presentation.kind ?? 'text';
  const size = reviewFileSize(presentation.size);
  const title = presentation.diffStatus === 'too_large' ? 'Large text file' : kind === 'directory' ? 'Nested repository or folder' : kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : kind === 'pdf' ? 'PDF document' : kind === 'symlink' ? 'Symbolic link' : kind === 'binary' ? 'Binary file' : 'No line changes';
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Play : kind === 'audio' ? Volume2 : kind === 'directory' ? Folder : FileCode;
  const description = deleted ? 'Deleted from this change.' : error || (presentation.diffStatus === 'too_large' ? 'This diff exceeds the preview limit. Open the file to inspect its contents.' : kind === 'directory' ? 'Directory contents are browsed in Files.' : kind === 'symlink' ? 'The link target is shown in the patch; previews do not follow symbolic links.' : kind === 'image' ? 'No image preview is available.' : kind === 'text' ? 'No text diff was returned for this file.' : 'This file has no line-by-line diff.');
  return <div data-review-asset={kind} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 16, fontFamily: UI_FONT, borderTop: '1px solid var(--t-divider-subtle)' }}>
    <Icon size={18} aria-hidden="true" style={{ color: 'var(--t-text-faint)', flexShrink: 0, marginTop: 2 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{title}{size ? <span style={{ marginLeft: 7, fontSize: 10.5, color: 'var(--t-text-faint)' }}>{historical ? 'Working copy · ' : ''}{size}</span> : null}</div>
      <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 4, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{description}</div>
      {!deleted && kind !== 'symlink' ? <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('o8:browse-review-file', { detail: { repoPath, path: kind === 'directory' ? null : path } }))} style={{ marginTop: 8, padding: 0, border: 0, background: 'transparent', color: 'var(--t-accent)', font: 'inherit', fontSize: 11, cursor: 'pointer' }}>{kind === 'directory' ? 'Browse in Files' : historical ? 'Open working copy in Files' : 'Open in Files'}</button> : null}
    </div>
  </div>;
}
