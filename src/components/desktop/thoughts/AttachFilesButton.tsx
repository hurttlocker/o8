'use client';

import { useEffect, useRef, useState } from 'react';
import { ComposerPopover } from './chat-panel/ComposerPopover';

interface FileSuggestion {
  path: string;
  name?: string;
}

/** Split a relative path into its directory and filename halves. */
function splitPath(path: string, name?: string): { dir: string; file: string } {
  const idx = path.lastIndexOf('/');
  const file = name?.trim() || (idx >= 0 ? path.slice(idx + 1) : path);
  const dir = idx >= 0 ? path.slice(0, idx) : '';
  return { dir, file };
}

/** Case-insensitive highlight of the matched query run inside a filename. */
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const start = lower.indexOf(q.toLowerCase());
  if (start < 0) return text;
  const end = start + q.length;
  return (
    <>
      {text.slice(0, start)}
      <span style={{ color: 'var(--t-accent)', fontWeight: 500 }}>{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  );
}

interface AttachFilesButtonProps {
  onFileReferenceSelect?: (path: string) => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  repoPath?: string | null;
}

function PlusGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function UploadGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 3.5 3.5" />
    </svg>
  );
}

export function AttachFilesButton({
  onFileReferenceSelect,
  onUploadDiskFiles,
  repoPath,
}: AttachFilesButtonProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      try {
        const headers: Record<string, string> = {};
        if (repoPath?.trim()) headers['x-cortex-repo-path'] = repoPath.trim();
        const response = await fetch(`/api/v2/context/files?q=${encodeURIComponent(trimmedQuery)}`, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          setSuggestions([]);
          return;
        }
        const data = await response.json() as { files?: FileSuggestion[] };
        setSuggestions(data.files ?? []);
      } catch {
        if (!controller.signal.aborted) setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 120);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, query, repoPath]);

  const selectFileReference = (path: string) => {
    onFileReferenceSelect?.(path);
    setQuery('');
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div style={{ display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        title="Attach files"
        aria-label="Attach files"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 7,
          borderWidth: 0,
          background: open ? 'var(--t-bg-card)' : 'transparent',
          color: open ? 'var(--t-text)' : 'var(--t-text-muted)',
          cursor: 'pointer',
          transition: 'color 120ms, background 120ms',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = 'var(--t-text)';
          event.currentTarget.style.background = 'var(--t-bg-card)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = open ? 'var(--t-text)' : 'var(--t-text-muted)';
          event.currentTarget.style.background = open ? 'var(--t-bg-card)' : 'transparent';
        }}
      >
        <PlusGlyph />
      </button>

      <input
        ref={fileInputRef}
        aria-label="Upload attachments from disk"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files && files.length > 0) onUploadDiskFiles?.(files);
          event.currentTarget.value = '';
          setOpen(false);
        }}
      />

      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end">
        <div
          style={{
            width: 288,
            maxWidth: 'min(288px, calc(100vw - 32px))',
            borderRadius: 14,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: 'var(--t-panel-shadow)',
            overflow: 'hidden',
          }}
        >
          <div style={{
            paddingTop: 10,
            paddingRight: 10,
            paddingBottom: 10,
            paddingLeft: 10,
            borderBottom: '1px solid var(--t-divider-subtle)',
          }}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 34,
                paddingTop: 0,
                paddingRight: 10,
                paddingBottom: 0,
                paddingLeft: 10,
                borderRadius: 9,
                border: '1px solid var(--t-input-border)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 500,
                letterSpacing: '-0.1px',
                fontFamily: 'var(--font-sans-system)',
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-bg-card)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--t-input-bg)'; }}
            >
              <UploadGlyph />
              Upload from disk
            </button>
          </div>

          <div style={{
            paddingTop: 10,
            paddingRight: 10,
            paddingBottom: 10,
            paddingLeft: 10,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              minHeight: 32,
              paddingTop: 0,
              paddingRight: 9,
              paddingBottom: 0,
              paddingLeft: 9,
              borderRadius: 9,
              border: '1px solid var(--t-input-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text-muted)',
            }}>
              <SearchGlyph />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search repo files"
                style={{
                  flex: 1,
                  minWidth: 0,
                  borderWidth: 0,
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 12.5,
                  fontWeight: 400,
                  letterSpacing: '-0.1px',
                  fontFamily: 'var(--font-sans-system)',
                }}
              />
            </div>

            <div style={{ marginTop: 8, maxHeight: 180, overflowY: 'auto' }}>
              {query.trim() && suggestions.length === 0 ? (
                <div style={{
                  paddingTop: 8,
                  paddingRight: 8,
                  paddingBottom: 8,
                  paddingLeft: 8,
                  color: 'var(--t-text-faint)',
                  fontSize: 11,
                  fontFamily: 'var(--font-sans-system)',
                }}>
                  {loading ? 'Searching...' : 'No files found'}
                </div>
              ) : null}
              {suggestions.map((file) => {
                const { dir, file: fileName } = splitPath(file.path, file.name);
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => selectFileReference(file.path)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1,
                      width: '100%',
                      paddingTop: 6,
                      paddingRight: 8,
                      paddingBottom: 6,
                      paddingLeft: 8,
                      borderWidth: 0,
                      borderRadius: 8,
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      overflow: 'hidden',
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-bg-card)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* Filename primary — sans, the thing you actually searched. */}
                    <span style={{
                      fontSize: 12.5,
                      fontWeight: 400,
                      letterSpacing: '-0.1px',
                      lineHeight: 1.3,
                      color: 'var(--t-text)',
                      fontFamily: 'var(--font-sans-system)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}>
                      {highlightMatch(fileName, query)}
                    </span>
                    {/* Directory secondary — dimmed mono, left-truncated so the
                        deepest (most relevant) folders stay visible. */}
                    {dir ? (
                      <span style={{
                        fontSize: 9.5,
                        fontWeight: 300,
                        lineHeight: 1.3,
                        color: 'var(--t-text-faint)',
                        fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: '100%',
                        direction: 'rtl',
                        textAlign: 'left',
                      }}>
                        {/* bidi isolate keeps the slashes reading left-to-right
                            while rtl puts the ellipsis at the START of the path. */}
                        <bdi>{dir}/</bdi>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </ComposerPopover>
    </div>
  );
}
