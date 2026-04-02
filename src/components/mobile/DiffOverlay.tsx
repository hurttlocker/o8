'use client';

import type { CSSProperties } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DiffOverlayProps } from './types';
import { useTheme } from './ThemeContext';
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
  const { colors } = useTheme();

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

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 45,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '24px 8px max(env(safe-area-inset-bottom, 0px), 8px)',
    background: 'rgba(0,0,0,0.72)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  };
  const sheetStyle: CSSProperties = {
    width: 'min(100%, 420px)',
    maxHeight: 'min(86vh, 780px)',
    display: 'grid',
    gap: 12,
    overflow: 'hidden',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(28,28,30,0.82)',
    boxShadow: '0 24px 52px rgba(0,0,0,0.36)',
  };
  const headStyle: CSSProperties = {
    display: 'grid',
    gap: 10,
    padding: '12px 16px 10px',
    borderBottom: `1px solid ${colors.border}`,
    background: 'rgba(28,28,30,0.92)',
  };
  const handleStyle: CSSProperties = {
    width: 40,
    height: 5,
    margin: '0 auto',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.14)',
  };
  const titleRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  };
  const titleStyle: CSSProperties = {
    margin: 0,
    color: colors.text,
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '-0.02em',
  };
  const headActionsStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };
  const iconButtonStyle: CSSProperties = {
    width: 36,
    height: 36,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    color: colors.text,
    cursor: 'pointer',
  };
  const doneButtonStyle: CSSProperties = {
    minHeight: 36,
    padding: '0 12px',
    borderRadius: 999,
    border: '1px solid rgba(10,132,255,0.24)',
    background: 'rgba(10,132,255,0.16)',
    color: colors.blueAccent,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  };
  const navRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '0 16px',
  };
  const positionChipStyle: CSSProperties = {
    minHeight: 28,
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 10px',
    borderRadius: 999,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 600,
  };
  const navActionsStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };
  const navButtonStyle = (disabled: boolean): CSSProperties => ({
    minHeight: 30,
    padding: '0 10px',
    borderRadius: 999,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    color: colors.text,
    fontSize: 12,
    fontWeight: 600,
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'default' : 'pointer',
  });
  const fileStripStyle: CSSProperties = {
    display: 'flex',
    gap: 8,
    padding: '0 16px',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
  };
  const filePillStyle = (active: boolean): CSSProperties => ({
    flexShrink: 0,
    minHeight: 34,
    maxWidth: 220,
    padding: '0 12px',
    borderRadius: 999,
    border: `1px solid ${active ? 'rgba(10,132,255,0.24)' : colors.border}`,
    background: active ? 'rgba(10,132,255,0.16)' : 'rgba(44,44,46,0.9)',
    color: active ? colors.blueAccent : colors.textSecondary,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    cursor: 'pointer',
  });
  const errorStyle: CSSProperties = {
    margin: '0 16px',
    padding: '10px 12px',
    borderRadius: 14,
    border: '1px solid rgba(255,69,58,0.18)',
    background: 'rgba(255,69,58,0.10)',
    color: colors.red,
    fontSize: 13,
    lineHeight: 1.5,
  };
  const scrollStyle: CSSProperties = {
    display: 'grid',
    gap: 12,
    padding: '0 16px 18px',
    overflowY: 'auto',
    minHeight: 0,
  };
  const metaRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 16px',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
  };
  const metaCopyStyle: CSSProperties = {
    minWidth: 0,
    display: 'grid',
    gap: 4,
  };
  const metaPathStyle: CSSProperties = {
    color: colors.text,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '-0.015em',
    wordBreak: 'break-word',
  };
  const metaPositionStyle: CSSProperties = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 500,
  };
  const metaDeltaStyle: CSSProperties = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  };
  const commitCardStyle: CSSProperties = {
    display: 'grid',
    gap: 4,
    padding: '12px 14px',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
  };
  const commitSummaryStyle: CSSProperties = {
    color: colors.text,
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.45,
  };
  const commitMetaStyle: CSSProperties = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 500,
  };
  const diffBlockStyle: CSSProperties = {
    overflow: 'hidden',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(18,18,20,0.96)',
  };
  const diffLineStyle = (tone: ReturnType<typeof diffLineTone>): CSSProperties => {
    if (tone === 'add') {
      return { background: 'rgba(48,209,88,0.10)' };
    }
    if (tone === 'remove') {
      return { background: 'rgba(255,69,58,0.10)' };
    }
    if (tone === 'meta' || tone === 'hunk') {
      return { background: 'rgba(10,132,255,0.10)' };
    }
    return { background: 'transparent' };
  };
  const diffRowStyle = (tone: ReturnType<typeof diffLineTone>): CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: '3px minmax(0, 1fr)',
    ...diffLineStyle(tone),
  });
  const diffGutterStyle = (tone: ReturnType<typeof diffLineTone>): CSSProperties => ({
    background: tone === 'add'
      ? colors.green
      : tone === 'remove'
        ? colors.red
        : tone === 'meta' || tone === 'hunk'
          ? colors.blueAccent
          : 'transparent',
    opacity: tone === 'context' ? 0 : 0.72,
  });
  const diffCodeStyle = (tone: ReturnType<typeof diffLineTone>): CSSProperties => ({
    display: 'block',
    padding: '6px 12px',
    color: tone === 'add'
      ? colors.green
      : tone === 'remove'
        ? colors.red
        : tone === 'meta' || tone === 'hunk'
          ? '#7CC3FF'
          : colors.text,
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  });
  const loadingCardStyle: CSSProperties = {
    padding: '18px 16px',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 1.5,
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" onClick={onClose}>
      <section style={sheetStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headStyle}>
          <div style={handleStyle} />
          <div style={titleRowStyle}>
            <h2 style={titleStyle}>Changes</h2>
            <div style={headActionsStyle}>
            <button
              type="button"
              style={iconButtonStyle}
              aria-label="Refresh diff"
              onClick={() => {
                if (selectedReviewFilePath) {
                  void onLoadFile(selectedReviewFilePath, true);
                } else {
                  void onRefresh();
                }
              }}
            >
              <RefreshCw size={16} strokeWidth={2.1} style={reviewFileLoadingPath === selectedReviewFilePath ? { animation: 'spin 1s linear infinite' } : undefined} />
            </button>
            <button type="button" style={doneButtonStyle} onClick={onClose}>
              Done
            </button>
            </div>
          </div>
        </div>

        {files.length ? (
          <>
            <div style={navRowStyle}>
              <div style={positionChipStyle}>
                {selectedPosition ? `${selectedPosition} of ${files.length}` : `${files.length} files`}
              </div>
              <div style={navActionsStyle}>
                <button type="button" style={navButtonStyle(!hasPrevFile)} onClick={() => jumpReviewFile('prev')} disabled={!hasPrevFile}>
                  Prev file
                </button>
                <button type="button" style={navButtonStyle(!hasNextFile)} onClick={() => jumpReviewFile('next')} disabled={!hasNextFile}>
                  Next file
                </button>
              </div>
            </div>
            <div style={fileStripStyle}>
              {files.map((file) => {
                const active = selectedReviewFilePath === file.path;
                return (
                  <button
                    key={`${file.status}:${file.path}`}
                    type="button"
                    style={filePillStyle(active)}
                    onClick={() => onFileSelect(file.path)}
                  >
                    {compactLine(file.path, file.path, 22)}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {reviewFileError ? <p style={errorStyle}>{reviewFileError}</p> : null}

        <div style={scrollStyle}>
          {currentFile ? (
            <>
              <div style={metaRowStyle}>
                <div style={metaCopyStyle}>
                  <strong style={metaPathStyle}>{currentFile.path}</strong>
                  <span style={metaPositionStyle}>{selectedPosition ? `${selectedPosition} of ${files.length}` : `${files.length} files`}</span>
                </div>
                <span style={metaDeltaStyle}>{`+${currentFile.additions ?? 0} / -${currentFile.deletions ?? 0}`}</span>
              </div>
              {currentFile.commitSummary ? (
                <div style={commitCardStyle}>
                  <span style={commitSummaryStyle}>{currentFile.commitSummary}</span>
                  <span style={commitMetaStyle}>
                    {currentFile.commitAuthor}{currentFile.commitAge ? ` · ${currentFile.commitAge}` : ''}
                  </span>
                </div>
              ) : null}
              <div style={diffBlockStyle}>
                {currentFile.preview.split('\n').map((line, index) => {
                  const tone = diffLineTone(line);
                  const displayLine = tone === 'add' || tone === 'remove'
                    ? line.slice(1)
                    : tone === 'context'
                      ? (line.startsWith(' ') ? line.slice(1) : line)
                      : line;
                  return (
                    <div key={`${currentFile.path}:${index}`} style={diffRowStyle(tone)}>
                      <div style={diffGutterStyle(tone)} />
                      <code style={diffCodeStyle(tone)}>{displayLine || '\u00A0'}</code>
                    </div>
                  );
                })}
              </div>
            </>
          ) : reviewFileLoadingPath ? (
            <div style={loadingCardStyle}>Loading repository diff…</div>
          ) : (
            <div style={loadingCardStyle}>No diff is selected on the mobile review surface yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
