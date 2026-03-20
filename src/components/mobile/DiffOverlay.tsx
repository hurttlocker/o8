'use client';

import { RefreshCw } from 'lucide-react';
import type { DiffOverlayProps } from './types';
import { diffLineTone } from './utils';

export function DiffOverlay({
  diffOpen,
  selectedFile,
  selectedReviewFilePath,
  reviewFiles,
  reviewFileByPath,
  stickyReviewFiles,
  reviewFileError,
  reviewFileLoadingPath,
  compactLine,
  onClose,
  onFileSelect,
  onLoadFile,
  onRefresh,
}: DiffOverlayProps) {
  if (!diffOpen) {
    return null;
  }

  const files = reviewFiles.length ? reviewFiles : stickyReviewFiles;
  const currentFile = selectedFile ?? (selectedReviewFilePath ? reviewFileByPath[selectedReviewFilePath] : undefined);
  const selectedIndex = selectedReviewFilePath
    ? files.findIndex((file) => file.path === selectedReviewFilePath)
    : -1;
  const selectedPosition = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  const hasPrevFile = selectedIndex > 0;
  const hasNextFile = selectedIndex >= 0 && selectedIndex < files.length - 1;

  const jumpReviewFile = (direction: 'prev' | 'next') => {
    if (!files.length) {
      return;
    }
    const fallbackIndex = direction === 'prev' ? files.length - 1 : 0;
    const currentIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
    const nextIndex = direction === 'prev'
      ? Math.max(0, currentIndex - 1)
      : Math.min(files.length - 1, currentIndex + 1);
    const nextFile = files[nextIndex];
    if (nextFile) {
      onFileSelect(nextFile.path);
    }
  };

  return (
    <div className="remodex-diff-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="remodex-diff-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="remodex-diff-sheet-head">
          <div className="remodex-diff-sheet-handle" />
          <h2>Changes</h2>
          <div className="remodex-sheet-head-actions">
            <button
              type="button"
              className="remodex-sheet-icon-button"
              aria-label="Refresh diff"
              onClick={() => {
                if (selectedReviewFilePath) {
                  void onLoadFile(selectedReviewFilePath, true);
                } else {
                  void onRefresh();
                }
              }}
            >
              <RefreshCw size={16} strokeWidth={2.1} className={reviewFileLoadingPath === selectedReviewFilePath ? 'spin' : undefined} />
            </button>
            <button type="button" className="remodex-done-button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        {files.length ? (
          <>
            <div className="remodex-diff-nav-row">
              <div className="remodex-diff-position-chip">
                {selectedPosition ? `${selectedPosition} of ${files.length}` : `${files.length} files`}
              </div>
              <div className="remodex-diff-nav-actions">
                <button type="button" className="remodex-diff-nav-button" onClick={() => jumpReviewFile('prev')} disabled={!hasPrevFile}>
                  Prev file
                </button>
                <button type="button" className="remodex-diff-nav-button" onClick={() => jumpReviewFile('next')} disabled={!hasNextFile}>
                  Next file
                </button>
              </div>
            </div>
            <div className="remodex-diff-file-strip">
              {files.map((file) => {
                const active = selectedReviewFilePath === file.path;
                return (
                  <button
                    key={`${file.status}:${file.path}`}
                    type="button"
                    className={`remodex-diff-file-pill ${active ? 'remodex-diff-file-pill-active' : ''}`}
                    onClick={() => onFileSelect(file.path)}
                  >
                    {compactLine(file.path, file.path, 22)}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {reviewFileError ? <p className="remodex-banner-note remodex-banner-note-sheet">{reviewFileError}</p> : null}

        <div className="remodex-diff-scroll">
          {currentFile ? (
            <>
              <div className="remodex-diff-meta-row">
                <div className="remodex-diff-meta-copy">
                  <strong>{currentFile.path}</strong>
                  <span className="remodex-diff-meta-position">{selectedPosition ? `${selectedPosition} of ${files.length}` : `${files.length} files`}</span>
                </div>
                <span>{`+${currentFile.additions ?? 0} / -${currentFile.deletions ?? 0}`}</span>
              </div>
              {currentFile.commitSummary ? (
                <div className="remodex-diff-commit-card">
                  <span className="remodex-diff-commit-summary">{currentFile.commitSummary}</span>
                  <span className="remodex-diff-commit-meta">
                    {currentFile.commitAuthor}{currentFile.commitAge ? ` · ${currentFile.commitAge}` : ''}
                  </span>
                </div>
              ) : null}
              <div className="remodex-diff-block">
                {currentFile.preview.split('\n').map((line, index) => {
                  const tone = diffLineTone(line);
                  const displayLine = tone === 'add' || tone === 'remove'
                    ? line.slice(1)
                    : tone === 'context'
                      ? (line.startsWith(' ') ? line.slice(1) : line)
                      : line;
                  return (
                    <div key={`${currentFile.path}:${index}`} className={`remodex-diff-line remodex-diff-line-${tone}`}>
                      <div className="remodex-diff-gutter" />
                      <code>{displayLine || '\u00A0'}</code>
                    </div>
                  );
                })}
              </div>
            </>
          ) : reviewFileLoadingPath ? (
            <div className="remodex-loading-card">Loading repository diff…</div>
          ) : (
            <div className="remodex-loading-card">No diff is selected on the mobile review surface yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
