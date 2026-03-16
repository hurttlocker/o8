'use client';

/**
 * UniversalSearch — search across conversations, agents, memory, issues, files.
 *
 * Desktop: glass bar at top of workspace.
 * Mobile: search bar inside hamburger menu.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  FileText,
  GitPullRequestDraft,
  MessageSquare,
  Monitor,
  Search,
  X,
} from 'lucide-react';

// ── Types ──

type ResultKind = 'conversation' | 'agent' | 'memory' | 'issue' | 'file';

interface SearchTarget {
  sessionKey?: string;
  issueNumber?: number;
  filePath?: string;
  line?: number;
  factId?: number;
}

interface SearchResult {
  kind: ResultKind;
  title: string;
  detail: string;
  target?: SearchTarget;
  score: number;
}

interface UniversalSearchProps {
  variant: 'desktop' | 'mobile';
  workspace?: string;
  /** JSON stringified agents array from inventory */
  agentsJson?: string;
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number) => void;
  onSelectFile?: (filePath: string, line?: number) => void;
  onSelectMemory?: (factId: number) => void;
  /** Close the container (e.g., hamburger menu) */
  onClose?: () => void;
}

const KIND_ICON: Record<ResultKind, typeof Search> = {
  conversation: MessageSquare,
  agent: Monitor,
  memory: Brain,
  issue: GitPullRequestDraft,
  file: FileText,
};

const KIND_COLOR: Record<ResultKind, string> = {
  conversation: '#007aff',
  agent: '#34c759',
  memory: '#af52de',
  issue: '#ff9f0a',
  file: '#8e8e93',
};

const KIND_LABEL: Record<ResultKind, string> = {
  conversation: 'Chat',
  agent: 'Agent',
  memory: 'Memory',
  issue: 'Issue',
  file: 'File',
};

/** Client-side agent search — avoids sending 30KB inventory in URL params */
function searchAgentsLocally(query: string, agentsJson?: string): SearchResult[] {
  if (!agentsJson || agentsJson === '[]') return [];
  try {
    const agents = JSON.parse(agentsJson);
    const lq = query.toLowerCase();
    const results: SearchResult[] = [];
    for (const agent of agents) {
      const name = (agent.name ?? '').toLowerCase();
      const task = (agent.currentTask ?? '').toLowerCase();
      const model = (agent.model ?? '').toLowerCase();
      if (name.includes(lq) || task.includes(lq) || model.includes(lq)) {
        results.push({
          kind: 'agent',
          title: agent.name ?? 'Unknown Agent',
          detail: `${agent.status ?? 'unknown'} · ${agent.currentTask || agent.model || ''}`.slice(0, 120),
          target: { sessionKey: agent.sessionKey },
          score: name.includes(lq) ? 0.9 : 0.6,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export const UniversalSearch = memo(function UniversalSearch({
  variant,
  workspace,
  agentsJson,
  onSelectSession,
  onSelectIssue,
  onSelectFile,
  onSelectMemory,
  onClose,
}: UniversalSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = variant === 'mobile';

  // Auto-focus on mount for mobile (it's inside the menu)
  useEffect(() => {
    if (isMobile) {
      // Small delay to let sheet animate in
      const t = setTimeout(() => inputRef.current?.focus(), 300);
      return () => clearTimeout(t);
    }
  }, [isMobile]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (workspace) params.set('workspace', workspace);
        // Note: agents are searched client-side to avoid oversized URLs

        const res = await fetch(`/api/panel/universal-search?${params.toString()}`);
        if (!res.ok) {
          setError('Search unavailable');
          setResults([]);
          return;
        }
        const data = await res.json();
        if (data.error) {
          setError(data.error);
          setResults([]);
        } else {
          // Merge server results with client-side agent search
          const serverResults: SearchResult[] = data.results ?? [];
          const agentResults = searchAgentsLocally(query.trim(), agentsJson);
          const merged = [...agentResults, ...serverResults].sort((a, b) => b.score - a.score);
          setResults(merged.slice(0, 25));
          setSelectedIndex(0);
        }
      } catch {
        setError('Network error — check your connection');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, workspace, agentsJson]);

  // Handle result selection
  const handleSelect = useCallback((result: SearchResult) => {
    const t = result.target;
    if (!t) return;

    if (t.sessionKey && onSelectSession) {
      onSelectSession(t.sessionKey);
    } else if (t.issueNumber && onSelectIssue) {
      onSelectIssue(t.issueNumber);
    } else if (t.filePath && onSelectFile) {
      onSelectFile(t.filePath, t.line ?? undefined);
    } else if (t.factId && onSelectMemory) {
      onSelectMemory(t.factId);
    }

    setQuery('');
    setResults([]);
    if (onClose) onClose();
  }, [onSelectSession, onSelectIssue, onSelectFile, onSelectMemory, onClose]);

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
      handleSelect(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      inputRef.current?.blur();
    }
  }, [results, selectedIndex, handleSelect]);

  // Click outside to close (desktop only)
  useEffect(() => {
    if (isMobile) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isMobile]);

  // ⌘K shortcut (desktop only)
  useEffect(() => {
    if (isMobile) return;
    function handleGlobalKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, [isMobile]);

  const showDropdown = (focused || isMobile) && (results.length > 0 || loading || error);
  const isEmpty = !loading && !error && query.trim().length >= 2 && results.length === 0;

  // ── Render ──

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: isMobile ? undefined : 480,
        margin: isMobile ? 0 : '0 auto',
      }}
    >
      {/* Search input */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: isMobile ? '10px 14px' : '7px 14px',
        borderRadius: isMobile ? 12 : 12,
        background: isMobile
          ? 'rgba(120, 120, 128, 0.12)'
          : (focused ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.45)'),
        backdropFilter: isMobile ? 'none' : 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: isMobile ? 'none' : 'blur(20px) saturate(1.6)',
        border: isMobile
          ? 'none'
          : (focused ? '1px solid rgba(59, 130, 246, 0.2)' : '1px solid rgba(0, 0, 0, 0.04)'),
        boxShadow: !isMobile && focused ? '0 4px 24px rgba(0, 0, 0, 0.06)' : 'none',
        transition: 'all 200ms ease',
      }}>
        <Search
          size={isMobile ? 16 : 14}
          strokeWidth={1.8}
          style={{ color: '#8e8e93', flexShrink: 0 }}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search everything…"
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontSize: isMobile ? 16 : 13,
            color: isMobile ? '#111827' : '#1e293b',
            fontFamily: '-apple-system, system-ui, sans-serif',
            fontWeight: 400,
            letterSpacing: '-0.01em',
            WebkitAppearance: 'none',
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(''); setResults([]); setError(null); inputRef.current?.focus(); }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              border: 'none',
              background: 'rgba(120, 120, 128, 0.12)',
              borderRadius: 10,
              padding: 4,
              cursor: 'pointer',
              color: '#8e8e93',
              minWidth: 22,
              minHeight: 22,
              justifyContent: 'center',
            }}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        ) : !isMobile ? (
          <kbd style={{
            fontSize: 10,
            color: '#b0b8c8',
            background: 'rgba(0,0,0,0.04)',
            padding: '2px 5px',
            borderRadius: 4,
            fontFamily: '-apple-system, system-ui, sans-serif',
            fontWeight: 500,
          }}>⌘K</kbd>
        ) : null}
      </div>

      {/* Results */}
      {showDropdown ? (
        <div style={{
          position: isMobile ? 'relative' : 'absolute',
          top: isMobile ? 0 : 'calc(100% + 6px)',
          left: 0,
          right: 0,
          maxHeight: isMobile ? 320 : 400,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          borderRadius: isMobile ? 0 : 14,
          background: isMobile ? 'transparent' : 'rgba(255, 255, 255, 0.92)',
          backdropFilter: isMobile ? 'none' : 'blur(24px) saturate(1.8)',
          WebkitBackdropFilter: isMobile ? 'none' : 'blur(24px) saturate(1.8)',
          border: isMobile ? 'none' : '1px solid rgba(0, 0, 0, 0.06)',
          boxShadow: isMobile ? 'none' : '0 12px 40px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.04)',
          zIndex: 100,
          marginTop: isMobile ? 8 : 0,
        }}>
          {/* Error state */}
          {error ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 16px',
              color: '#ff3b30',
              fontSize: 13,
            }}>
              <AlertCircle size={16} strokeWidth={2} />
              {error}
            </div>
          ) : null}

          {/* Loading state */}
          {loading && results.length === 0 && !error ? (
            <div style={{
              padding: '16px 18px',
              fontSize: 12,
              color: '#8e8e93',
            }}>
              Searching conversations, memory, issues, files…
            </div>
          ) : null}

          {/* Results grouped by kind */}
          {results.map((result, i) => {
            const isSelected = !isMobile && i === selectedIndex;
            const Icon = KIND_ICON[result.kind] ?? FileText;
            const color = KIND_COLOR[result.kind];
            const label = KIND_LABEL[result.kind];

            return (
              <button
                key={`${result.kind}:${result.title}:${i}`}
                type="button"
                onClick={() => handleSelect(result)}
                onMouseEnter={() => !isMobile && setSelectedIndex(i)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  width: '100%',
                  padding: isMobile ? '12px 0' : '10px 16px',
                  border: 'none',
                  borderBottom: i < results.length - 1
                    ? `1px solid ${isMobile ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.03)'}`
                    : 'none',
                  background: isSelected ? 'rgba(59, 130, 246, 0.06)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 80ms ease',
                  WebkitTapHighlightColor: 'transparent',
                  minHeight: 44,
                }}
              >
                {/* Kind icon */}
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: `${color}14`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 1,
                }}>
                  <Icon size={14} strokeWidth={2} style={{ color }} />
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: '#111827',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}>
                      {result.title}
                    </span>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color,
                      background: `${color}14`,
                      padding: '1px 6px',
                      borderRadius: 6,
                      flexShrink: 0,
                      textTransform: 'uppercase',
                      letterSpacing: '0.03em',
                    }}>
                      {label}
                    </span>
                  </div>
                  {result.detail ? (
                    <div style={{
                      fontSize: 12,
                      color: '#8e8e93',
                      lineHeight: 1.4,
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {result.detail}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Empty state */}
      {isEmpty ? (
        <div style={{
          padding: isMobile ? '16px 0' : '16px 18px',
          fontSize: 13,
          color: '#aeaeb2',
          textAlign: 'center',
          ...(isMobile ? {} : {
            position: 'absolute' as const,
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            borderRadius: 14,
            background: 'rgba(255, 255, 255, 0.92)',
            backdropFilter: 'blur(24px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.8)',
            border: '1px solid rgba(0, 0, 0, 0.06)',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.1)',
            zIndex: 100,
          }),
        }}>
          No results for &ldquo;{query.trim()}&rdquo;
        </div>
      ) : null}
    </div>
  );
});
