'use client';
/* eslint-disable @next/next/no-img-element -- local repo assets need raw media tags */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownRender } from '../markdown-render';
import { SyntaxFileView } from './SyntaxFileView';
import { FileTypeIcon } from './FileTypeIcon';
import { reviewFileKind } from '@/lib/review/file-presentation';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

type FileKind = 'image' | 'markdown' | 'pdf' | 'svg' | 'text' | 'video' | 'audio' | 'binary';
type SourceViewMode = 'preview' | 'source';

interface FileResponse {
  content?: string;
  error?: string;
  truncated?: boolean;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpg', 'jpeg', 'png', 'webp']);

function extensionForPath(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

function fileKindForPath(path: string): FileKind {
  const extension = extensionForPath(path);
  if (extension === 'pdf') return 'pdf';
  if (extension === 'svg') return 'svg';
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  const kind = reviewFileKind(path);
  return kind === 'video' || kind === 'audio' || kind === 'binary' ? kind : 'text';
}

function canReadAsText(kind: FileKind) {
  return kind === 'text' || kind === 'markdown' || kind === 'svg';
}

function defaultViewMode(kind: FileKind): SourceViewMode {
  return kind === 'markdown' || kind === 'svg' ? 'preview' : 'source';
}

function assetUrlFor(repoPath: string, selectedFile: string) {
  const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
  return `/api/panel/file-asset?${params.toString()}`;
}

function FileIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function PreviewToggle({
  mode,
  onModeChange,
}: {
  mode: SourceViewMode;
  onModeChange: (mode: SourceViewMode) => void;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', padding: 2 }}>
      {(['preview', 'source'] as const).map((option) => {
        const active = mode === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onModeChange(option)}
            style={{
              minHeight: 22,
              border: 'none',
              borderRadius: 6,
              background: active ? 'var(--t-accent-soft)' : 'transparent',
              color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: UI_FONT,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              textTransform: 'capitalize',
            }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function MediaPreview({
  kind,
  assetUrl,
  fileName,
  svgSource,
  onError,
}: {
  kind: FileKind;
  assetUrl: string;
  fileName: string;
  svgSource?: string;
  onError: () => void;
}) {
  if (kind === 'pdf') {
    return (
      <iframe
        title={fileName}
        src={`${assetUrl}#toolbar=1&navpanes=0`}
        style={{
          flex: 1,
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'var(--t-bg)',
        }}
      />
    );
  }
  if (kind === 'video' || kind === 'audio') {
    return <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20, fontFamily: UI_FONT }}>
      {kind === 'video' ? <video aria-label={fileName} src={assetUrl} controls preload="none" playsInline onError={onError} style={{ display: 'block', width: '100%', maxHeight: 'calc(100vh - 200px)', borderRadius: 10, background: 'var(--t-bg-subtle)' }} /> : <audio aria-label={fileName} src={assetUrl} controls preload="none" onError={onError} style={{ width: '100%' }} />}
      <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.4 }}>Play to load this {kind === 'video' ? 'video' : 'audio file'}.</span>
    </div>;
  }

  const imageSrc = kind === 'svg' && svgSource
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSource)}`
    : assetUrl;

  return (
    <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          borderRadius: 12,
          border: '1px solid var(--t-divider-subtle)',
          background:
            'linear-gradient(45deg, rgba(148,163,184,0.12) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,0.12) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,0.12) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,0.12) 75%)',
          backgroundColor: 'var(--t-bg-card)',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
          backgroundSize: '20px 20px',
          boxShadow: 'var(--t-panel-shadow)',
          overflow: 'hidden',
          padding: 18,
        }}
      >
        <img
          src={imageSrc}
          alt={fileName}
          onError={onError}
          style={{
            display: 'block',
            maxWidth: 'min(100%, 900px)',
            maxHeight: 'calc(100vh - 190px)',
            objectFit: 'contain',
          }}
        />
      </div>
    </div>
  );
}

export function FileViewer({
  repoPath,
  selectedFile,
  headerAction,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  headerAction?: ReactNode;
}) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [viewModeByFile, setViewModeByFile] = useState<Record<string, SourceViewMode>>({});
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);
  const fileKind = selectedFile ? fileKindForPath(selectedFile) : 'text';
  const viewMode = selectedFile ? viewModeByFile[selectedFile] ?? defaultViewMode(fileKind) : 'source';
  const canTogglePreview = fileKind === 'markdown' || fileKind === 'svg';
  const editing = selectedFile === editingFile && !truncated;
  const showEditControl = canReadAsText(fileKind) && !truncated;
  const assetUrl = selectedFile && repoPath && ['image', 'pdf', 'svg', 'video', 'audio'].includes(fileKind)
    ? assetUrlFor(repoPath, selectedFile)
    : null;
  const fileName = selectedFile?.split('/').pop() ?? selectedFile ?? 'file';
  const isAbsolutePath = selectedFile?.startsWith('/') ?? false;

  useEffect(() => {
    setTruncated(false);
    if (!selectedFile) {
      setFileContent(null);
      setEditContent('');
      setError(null);
      setDirty(false);
      setLoading(false);
      return;
    }
    if (!repoPath && !isAbsolutePath) {
      setFileContent(null);
      setEditContent('');
      setError('Select a repo before loading file content.');
      setDirty(false);
      setLoading(false);
      return;
    }

    if (!canReadAsText(fileKind)) {
      setFileContent(null);
      setEditContent('');
      setError(null);
      setDirty(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setFileContent(null);
    setEditContent('');
    setDirty(false);
    // Absolute paths (a file opened from anywhere on disk, e.g. Finder → Open in
    // o8) read through the operator file-io endpoint — it serves ANY absolute
    // path with operator trust, while confining worker tokens to registered
    // repos (§HIGH-6). Repo-relative paths keep the repo-scoped /api/v2/files.
    const url = isAbsolutePath
      ? `/api/panel/file-io?path=${encodeURIComponent(selectedFile)}`
      : (() => {
          const params = new URLSearchParams({ path: selectedFile, preview: '1' });
          if (repoPath) params.set('workspace', repoPath);
          return `/api/v2/files?${params.toString()}`;
        })();
    fetch(url)
      .then((response) => response.json() as Promise<FileResponse>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          setFileContent(null);
          setEditContent('');
          return;
        }
        const content = data.content ?? '';
        if (content.includes('\0')) { setError('This binary file has no text preview.'); return; }
        setTruncated(data.truncated === true);
        setFileContent(content);
        setEditContent(content);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to read file');
          setFileContent(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [fileKind, isAbsolutePath, repoPath, selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || (!repoPath && !isAbsolutePath) || !dirty || truncated) return;
    setSaving(true);
    setError(null);
    try {
      if (isAbsolutePath) {
        // An arbitrary on-disk file — save through the operator file-io endpoint
        // (PUT), the same worker-confined operator-trust path the read uses. The
        // repo-scoped /api/v2/files would reject the absolute path.
        const response = await fetch('/api/panel/file-io', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: selectedFile, content: editContent }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
        if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to save file');
      } else {
        const response = await fetch('/api/v2/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: selectedFile, content: editContent, workspace: repoPath }),
        });
        const data = await response.json().catch(() => ({})) as FileResponse;
        if (!response.ok) throw new Error(data.error || 'Unable to save file');
      }
      setFileContent(editContent);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save file');
    } finally {
      setSaving(false);
    }
  }, [dirty, editContent, isAbsolutePath, repoPath, selectedFile, truncated]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's' && dirty && selectedFile) {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dirty, handleSave, selectedFile]);

  const handleEditorScroll = useCallback(() => {
    if (textareaRef.current && lineNumberRef.current) {
      lineNumberRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const handleViewModeChange = useCallback((nextMode: SourceViewMode) => {
    if (!selectedFile) return;
    if (nextMode === 'preview') setEditingFile(null);
    setViewModeByFile((current) => ({ ...current, [selectedFile]: nextMode }));
  }, [selectedFile]);

  if (!selectedFile) {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', color: 'var(--t-text-muted)', fontFamily: UI_FONT }}>
        {headerAction ? <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 9, paddingRight: 12 }}>{headerAction}</div> : null}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
          <FileIcon size={32} />
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>Select a file to view</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, borderBottom: '1px solid var(--t-divider-subtle)', paddingTop: 5, paddingRight: 8, paddingBottom: 5, paddingLeft: 12, fontFamily: UI_FONT }}>
        <FileTypeIcon name={selectedFile} size={14} />
        <div title={selectedFile} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, color: 'var(--t-text)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{fileName}</span>
          {selectedFile.includes('/') ? <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-muted)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{selectedFile.slice(0, selectedFile.lastIndexOf('/')) || '/'}</span> : null}
        </div>
        {canTogglePreview ? <PreviewToggle mode={viewMode} onModeChange={handleViewModeChange} /> : null}
        {showEditControl && fileContent !== null ? <button type="button" aria-label={editing ? 'Read file' : 'Edit file'} aria-pressed={editing} onClick={() => { if (!editing) handleViewModeChange('source'); setEditingFile(editing ? null : selectedFile); }}
          style={{ minHeight: 26, border: 0, borderRadius: 6, background: editing ? 'var(--t-accent-soft)' : 'transparent', color: 'var(--t-text-secondary)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 11, fontWeight: 300, paddingLeft: 7, paddingRight: 7 }}>{editing ? 'Read' : 'Edit'}</button> : null}
        {showEditControl && viewMode === 'source' && !editing ? <button type="button" aria-label="Word wrap" title={wrapLines ? 'Turn word wrap off' : 'Turn word wrap on'} aria-pressed={wrapLines} onClick={() => setWrapLines(value => !value)}
          style={{ width: 26, height: 26, flexShrink: 0, border: 0, borderRadius: 6, padding: 0, background: wrapLines ? 'var(--t-hover)' : 'transparent', color: wrapLines ? 'var(--t-text-secondary)' : 'var(--t-text-muted)', cursor: 'pointer' }}><svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M4 10h12a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M4 15h3M4 20h3" /></svg></button> : null}
        {headerAction}
      </div>
      {truncated ? <div role="status" style={{ flexShrink: 0, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11, lineHeight: 1.5, borderBottom: '1px solid var(--t-divider-subtle)' }}>Read-only preview · first 1 MB. Use an editor to change the full file.</div> : null}
      {dirty || error ? (
        <div style={{ minHeight: 34, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, borderBottom: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-card)', paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, fontFamily: UI_FONT }}>
          <span style={{ flex: 1, minWidth: 0, color: error ? 'var(--t-brand-red)' : 'var(--t-text-muted)', fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error ?? (dirty ? 'Modified' : '')}
          </span>
          {dirty ? (
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={saving}
              style={{
                minHeight: 24,
                border: 'none',
                borderRadius: 8,
                background: 'var(--t-accent)',
                color: 'var(--t-on-accent, #ffffff)',
                cursor: saving ? 'wait' : 'pointer',
                fontFamily: UI_FONT,
                fontSize: 11,
                fontWeight: 400,
                letterSpacing: '-0.1px',
                opacity: saving ? 0.72 : 1,
                paddingTop: 0,
                paddingRight: 10,
                paddingBottom: 0,
                paddingLeft: 10,
              }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          ) : null}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {loading ? (
          <div style={{ paddingTop: 14, paddingRight: 16, paddingBottom: 14, paddingLeft: 16, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading file...</div>
        ) : fileKind === 'binary' ? <div style={{ padding: 20, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12, lineHeight: 1.6 }}>This binary file has no text preview.</div>
        : assetUrl && (['image', 'pdf', 'video', 'audio'].includes(fileKind) || (fileKind === 'svg' && viewMode === 'preview')) ? (
          <MediaPreview
            kind={fileKind}
            assetUrl={assetUrl}
            fileName={fileName}
            svgSource={fileKind === 'svg' ? editContent : undefined}
            onError={() => setError('Unable to preview this file.')}
          />
        ) : fileKind === 'markdown' && viewMode === 'preview' && fileContent !== null ? (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none', paddingTop: 18, paddingRight: 22, paddingBottom: 22, paddingLeft: 22 }}>
            <MarkdownRender content={editContent} />
          </div>
        ) : fileContent !== null && !editing ? (
          <SyntaxFileView path={selectedFile} content={editContent} wrap={wrapLines} />
        ) : fileContent !== null ? (
          <>
            <div
              ref={lineNumberRef}
              style={{
                width: 50,
                flexShrink: 0,
                overflowY: 'hidden',
                overflowX: 'hidden',
                background: 'var(--t-bg-subtle)',
                borderRight: '1px solid var(--t-divider-subtle)',
                userSelect: 'none',
                paddingTop: 8,
                paddingBottom: 8,
              }}
            >
              {editContent.split('\n').map((_, index) => (
                <div
                  key={index}
                  style={{
                    height: 19,
                    lineHeight: '19px',
                    color: 'var(--t-text-faint)',
                    fontFamily: MONO_FONT,
                    fontSize: 10.5,
                    paddingRight: 8,
                    textAlign: 'right',
                  }}
                >
                  {index + 1}
                </div>
              ))}
            </div>
            <textarea
              className="cortex-scroll-fade-y cortex-themed-scroll"
              ref={textareaRef}
              value={editContent}
              onChange={(event) => {
                setEditContent(event.target.value);
                setDirty(event.target.value !== fileContent);
              }}
              onScroll={handleEditorScroll}
              spellCheck={false}
              wrap="off"
              style={{
                flex: 1,
                minWidth: 0,
                resize: 'none',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--t-text)',
                caretColor: 'var(--t-text)',
                fontFamily: MONO_FONT,
                fontSize: 12,
                lineHeight: '19px',
                tabSize: 2,
                whiteSpace: 'pre',
                overflowX: 'auto',
                overflowY: 'auto',
                paddingTop: 8,
                paddingRight: 16,
                paddingBottom: 8,
                paddingLeft: 12,
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                event.preventDefault();
                const target = event.currentTarget;
                const start = target.selectionStart;
                const end = target.selectionEnd;
                const nextValue = target.value.substring(0, start) + '  ' + target.value.substring(end);
                setEditContent(nextValue);
                setDirty(nextValue !== fileContent);
                requestAnimationFrame(() => {
                  target.selectionStart = start + 2;
                  target.selectionEnd = start + 2;
                });
              }}
            />
          </>
        ) : (
          <div style={{ paddingTop: 14, paddingRight: 16, paddingBottom: 14, paddingLeft: 16, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            {error ?? 'Unable to read file'}
          </div>
        )}
      </div>
    </div>
  );
}
