/**
 * WorkspaceSearch — Glass search bar for the workspace canvas.
 *
 * Minimal, almost invisible until focused. Results drop down
 * below with file + line previews. Click → opens in canvas.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Search, X } from 'lucide-react';

interface SearchResult {
  file: string;
  line: number;
  text: string;
  matchType: 'code' | 'filename';
}

interface WorkspaceSearchProps {
  workspace?: string;
  onSelectFile?: (filePath: string, line?: number) => void;
}

export const WorkspaceSearch = memo(function WorkspaceSearch({ workspace, onSelectFile }: WorkspaceSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
        const res = await fetch(`/api/panel/search?q=${encodeURIComponent(query.trim())}${wsParam}`);
        const data = await res.json();
        setResults(data.results ?? []);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, workspace]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      const r = results[selectedIndex];
      onSelectFile?.(r.file, r.line || undefined);
      setQuery('');
      setResults([]);
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      inputRef.current?.blur();
    }
  }, [results, selectedIndex, onSelectFile]);

  // Click outside to close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ⌘K shortcut
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

  const showDropdown = focused && (results.length > 0 || loading);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', maxWidth: 480, margin: '0 auto' }}>
      {/* Search input */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 7,
        paddingRight: 14,
        paddingBottom: 7,
        paddingLeft: 14,
        borderRadius: 12,
        background: focused ? 'var(--t-panel)' : 'var(--t-panel-translucent)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        border: focused ? '1px solid rgba(59, 130, 246, 0.2)' : '1px solid var(--t-divider-subtle)',
        boxShadow: focused ? '0 4px 24px var(--t-panel-shadow)' : 'none',
        transition: 'all 200ms ease',
      }}>
        <Search size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search workspace…"
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontSize: 13,
            color: 'var(--t-text)',
            fontFamily: '-apple-system, system-ui, sans-serif',
            fontWeight: 400,
            letterSpacing: '-0.01em',
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              border: 'none',
              background: 'transparent',
              padding: 2,
              cursor: 'pointer',
              color: 'var(--t-text-muted)',
            }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        ) : (
          <kbd style={{
            fontSize: 10,
            color: 'var(--t-text-faint)',
            background: 'var(--t-divider-subtle)',
            padding: '2px 5px',
            borderRadius: 4,
            fontFamily: '-apple-system, system-ui, sans-serif',
            fontWeight: 500,
          }}>⌘K</kbd>
        )}
      </div>

      {/* Dropdown results */}
      {showDropdown ? (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          right: 0,
          maxHeight: 360,
          overflowY: 'auto',
          borderRadius: 14,
          background: 'var(--t-panel)',
          backdropFilter: 'blur(24px) saturate(1.8)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.8)',
          border: '1px solid var(--t-divider)',
          boxShadow: 'var(--t-panel-shadow)',
          zIndex: 100,
        }}>
          {loading && results.length === 0 ? (
            <div style={{ padding: '16px 18px', fontSize: 12, color: 'var(--t-text-muted)' }}>
              Searching…
            </div>
          ) : (
            results.map((result, i) => {
              const isSelected = i === selectedIndex;
              const fileName = result.file.split('/').pop() ?? result.file;
              const dirPath = result.file.includes('/') ? result.file.slice(0, result.file.lastIndexOf('/')) : '';

              return (
                <button
                  key={`${result.file}:${result.line}:${i}`}
                  type="button"
                  onClick={() => {
                    onSelectFile?.(result.file, result.line || undefined);
                    setQuery('');
                    setResults([]);
                    inputRef.current?.blur();
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    width: '100%',
                    paddingTop: 10,
                    paddingRight: 16,
                    paddingBottom: 10,
                    paddingLeft: 16,
                    border: 'none',
                    borderBottom: i < results.length - 1 ? '1px solid var(--t-divider-subtle)' : 'none',
                    background: isSelected ? 'rgba(59, 130, 246, 0.06)' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    transition: 'background 80ms ease',
                  }}
                >
                  <FileText size={14} strokeWidth={1.5} style={{
                    flexShrink: 0,
                    color: result.matchType === 'filename' ? '#3b82f6' : 'var(--t-text-muted)',
                    marginTop: 1,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--t-text)',
                      }}>{fileName}</span>
                      {result.line > 0 ? (
                        <span style={{
                          fontSize: 11,
                          color: '#3b82f6',
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                          fontWeight: 500,
                        }}>:{result.line}</span>
                      ) : null}
                      {dirPath ? (
                        <span style={{
                          fontSize: 10,
                          color: 'var(--t-text-faint)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>{dirPath}</span>
                      ) : null}
                    </div>
                    {result.text ? (
                      <div style={{
                        fontSize: 11,
                        color: 'var(--t-text-secondary)',
                        marginTop: 3,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        lineHeight: 1.4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>{result.text}</div>
                    ) : null}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
});
