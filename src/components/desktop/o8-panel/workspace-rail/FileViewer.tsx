'use client';
/* eslint-disable @next/next/no-img-element -- local repo assets need raw media tags */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownRender } from '../markdown-render';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

type FileKind = 'image' | 'markdown' | 'pdf' | 'svg' | 'text';
type SourceViewMode = 'preview' | 'source';

interface FileResponse {
  content?: string;
  error?: string;
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
  return 'text';
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
              fontSize: 10.5,
              fontWeight: 750,
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
}: {
  repoPath?: string | null;
  selectedFile: string | null;
}) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [viewModeByFile, setViewModeByFile] = useState<Record<string, SourceViewMode>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);
  const fileKind = selectedFile ? fileKindForPath(selectedFile) : 'text';
  const viewMode = selectedFile ? viewModeByFile[selectedFile] ?? defaultViewMode(fileKind) : 'source';
  const canTogglePreview = fileKind === 'markdown' || fileKind === 'svg';
  const assetUrl = selectedFile && repoPath && (fileKind === 'image' || fileKind === 'pdf' || fileKind === 'svg')
    ? assetUrlFor(repoPath, selectedFile)
    : null;
  const fileName = selectedFile?.split('/').pop() ?? selectedFile ?? 'file';

  useEffect(() => {
    if (!selectedFile) {
      setFileContent(null);
      setEditContent('');
      setError(null);
      setDirty(false);
      setLoading(false);
      return;
    }
    if (!repoPath) {
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
    const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
    fetch(`/api/v2/files?${params.toString()}`)
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
  }, [fileKind, repoPath, selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !repoPath || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: editContent, workspace: repoPath }),
      });
      const data = await response.json().catch(() => ({})) as FileResponse;
      if (!response.ok) throw new Error(data.error || 'Unable to save file');
      setFileContent(editContent);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save file');
    } finally {
      setSaving(false);
    }
  }, [dirty, editContent, repoPath, selectedFile]);

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
    setViewModeByFile((current) => ({ ...current, [selectedFile]: nextMode }));
  }, [selectedFile]);

  if (!selectedFile) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--t-text-muted)', fontFamily: UI_FONT }}>
        <FileIcon size={32} />
        <span style={{ fontSize: 13, fontWeight: 650 }}>Select a file to view</span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {dirty || error || canTogglePreview ? (
        <div style={{ minHeight: 34, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, borderBottom: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-card)', paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, fontFamily: UI_FONT }}>
          <span style={{ flex: 1, minWidth: 0, color: error ? 'var(--t-brand-red)' : 'var(--t-text-muted)', fontSize: 11, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error ?? (dirty ? 'Modified' : fileKind === 'markdown' ? 'Markdown preview' : 'SVG preview')}
          </span>
          {canTogglePreview ? <PreviewToggle mode={viewMode} onModeChange={handleViewModeChange} /> : null}
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
                fontWeight: 750,
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
        ) : assetUrl && (fileKind === 'image' || fileKind === 'pdf' || (fileKind === 'svg' && viewMode === 'preview')) ? (
          <MediaPreview
            kind={fileKind}
            assetUrl={assetUrl}
            fileName={fileName}
            svgSource={fileKind === 'svg' ? editContent : undefined}
            onError={() => setError('Unable to preview this file.')}
          />
        ) : fileKind === 'markdown' && viewMode === 'preview' && fileContent !== null ? (
          <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 18, paddingRight: 22, paddingBottom: 22, paddingLeft: 22 }}>
            <MarkdownRender content={editContent} />
          </div>
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
                    height: 18,
                    lineHeight: '18px',
                    color: 'var(--t-text-faint)',
                    fontFamily: MONO_FONT,
                    fontSize: 10,
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
                fontSize: 11,
                lineHeight: '18px',
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
