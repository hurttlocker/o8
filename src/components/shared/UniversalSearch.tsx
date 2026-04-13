'use client';

/**
 * UniversalSearch — command palette + cross-workspace search.
 *
 * Desktop: command palette in the title bar.
 * Mobile: search bar inside the controls sheet.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  FileText,
  FolderOpen,
  GitPullRequestDraft,
  MessageSquare,
  Monitor,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X,
  type LucideIcon,
} from '@/components/desktop/lucide-shims';

type ResultKind = 'conversation' | 'agent' | 'issue' | 'file' | 'symbol';
type CommandPaletteCategory = 'attention' | 'workspace' | 'review' | 'recovery' | 'settings';
export type CommandPaletteStateTone = 'blue' | 'green' | 'amber' | 'red' | 'slate' | 'purple';

interface SearchTarget {
  sessionKey?: string;
  issueNumber?: number;
  filePath?: string;
  line?: number;
}

interface SearchResult {
  kind: ResultKind;
  title: string;
  detail: string;
  target?: SearchTarget;
  score: number;
}

export interface CommandPaletteAction {
  id: string;
  title: string;
  detail: string;
  category: CommandPaletteCategory;
  stateLabel?: string;
  stateTone?: CommandPaletteStateTone;
  keywords?: string[];
  shortcut?: string;
  priority?: number;
  closeOnRun?: boolean;
  disabled?: boolean;
  unavailableReason?: string;
  run: () => void | Promise<void>;
}

interface UniversalSearchProps {
  variant: 'desktop' | 'mobile';
  workspace?: string;
  repo?: string;
  agentsJson?: string;
  actions?: CommandPaletteAction[];
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number) => void;
  onSelectFile?: (filePath: string, line?: number) => void;
  onClose?: () => void;
}

type PaletteItem =
  | {
      id: string;
      itemKind: 'action';
      title: string;
      detail: string;
      badge: string;
      color: string;
      Icon: LucideIcon;
      section: string;
      shortcut?: string;
      score: number;
      closeOnRun: boolean;
      stateLabel?: string;
      stateTone?: CommandPaletteStateTone;
      disabled: boolean;
      unavailableReason?: string;
      run: () => void | Promise<void>;
    }
  | {
      id: string;
      itemKind: 'search';
      title: string;
      detail: string;
      badge: string;
      color: string;
      Icon: LucideIcon;
      section: string;
      score: number;
      target?: SearchTarget;
    };

const KIND_ICON: Record<ResultKind, LucideIcon> = {
  conversation: MessageSquare,
  agent: Monitor,
  issue: GitPullRequestDraft,
  file: FileText,
  symbol: Sparkles,
};

const KIND_COLOR: Record<ResultKind, string> = {
  conversation: '#2563eb',
  agent: '#16a34a',
  issue: '#f97316',
  file: '#64748b',
  symbol: '#0f766e',
};

const KIND_LABEL: Record<ResultKind, string> = {
  conversation: 'Chat',
  agent: 'Session',
  issue: 'Issue',
  file: 'File',
  symbol: 'Symbol',
};

const ACTION_META: Record<CommandPaletteCategory, { badge: string; color: string; section: string; Icon: LucideIcon }> = {
  attention: { badge: 'Attention', color: '#f97316', section: 'Needs attention', Icon: AlertCircle },
  workspace: { badge: 'Workspace', color: '#2563eb', section: 'Workspace', Icon: FolderOpen },
  review: { badge: 'Review', color: '#16a34a', section: 'Review', Icon: GitPullRequestDraft },
  recovery: { badge: 'Recovery', color: '#dc2626', section: 'Recovery', Icon: RefreshCw },
  settings: { badge: 'Settings', color: '#64748b', section: 'Settings', Icon: Settings2 },
};

const ACTION_STATE_META: Record<CommandPaletteStateTone, { color: string; background: string }> = {
  blue: { color: '#2563eb', background: 'rgba(37, 99, 235, 0.12)' },
  green: { color: '#15803d', background: 'rgba(34, 197, 94, 0.14)' },
  amber: { color: '#b45309', background: 'rgba(245, 158, 11, 0.14)' },
  red: { color: '#b91c1c', background: 'rgba(239, 68, 68, 0.14)' },
  slate: { color: '#475569', background: 'rgba(148, 163, 184, 0.14)' },
  purple: { color: '#7c3aed', background: 'rgba(124, 58, 237, 0.12)' },
};

function searchAgentsLocally(query: string, agentsJson?: string): SearchResult[] {
  if (!agentsJson || agentsJson === '[]') return [];
  try {
    const agents = JSON.parse(agentsJson);
    const lq = query.toLowerCase();
    const results: SearchResult[] = [];
    for (const agent of agents) {
      const name = String(agent.name ?? '').toLowerCase();
      const task = String(agent.currentTask ?? '').toLowerCase();
      const model = String(agent.model ?? '').toLowerCase();
      if (name.includes(lq) || task.includes(lq) || model.includes(lq)) {
        const statusLabel = agent.repoReadiness?.label
          ?? (agent.status === 'reviewing'
            ? 'Reviewing'
            : agent.status === 'waiting'
              ? 'Waiting'
              : agent.status === 'blocked' || agent.status === 'failed'
                ? 'Blocked'
                : agent.status === 'idle'
                  ? 'Ready'
                  : 'Working');
        results.push({
          kind: 'agent',
          title: agent.name ?? 'Unknown session',
          detail: `${statusLabel} · ${agent.repoReadiness?.summary || agent.currentTask || agent.model || ''}`.slice(0, 120),
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

function actionMatchScore(action: CommandPaletteAction, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return action.priority ?? 0;
  }

  const haystack = [
    action.title,
    action.detail,
    action.stateLabel,
    action.unavailableReason,
    ...(action.keywords ?? []),
  ]
    .join(' ')
    .toLowerCase();

  if (!haystack.includes(normalizedQuery)) {
    return -1;
  }

  let score = action.priority ?? 0;
  if (action.title.toLowerCase().startsWith(normalizedQuery)) score += 120;
  if (action.title.toLowerCase().includes(normalizedQuery)) score += 80;
  if ((action.keywords ?? []).some((keyword) => keyword.toLowerCase().startsWith(normalizedQuery))) score += 45;
  if (haystack.includes(normalizedQuery)) score += 20;
  return score;
}

function retrySearchBump(current: number) {
  return current + 1;
}

export const UniversalSearch = memo(function UniversalSearch({
  variant,
  workspace,
  repo,
  agentsJson,
  actions = [],
  onSelectSession,
  onSelectIssue,
  onSelectFile,
  onClose,
}: UniversalSearchProps) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = variant === 'mobile';

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      if (!isMobile) setFocused(true);
    }, isMobile ? 300 : 0);
    return () => clearTimeout(timer);
  }, [isMobile]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim() || query.trim().length < 2) {
      setSearchResults([]);
      setLoading(false);
      if (!query.trim()) {
        setError(null);
      }
      return;
    }

    setLoading(true);
    setError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (workspace) params.set('workspace', workspace);
        if (repo) params.set('repo', repo);

        const response = await fetch(`/api/panel/universal-search?${params.toString()}`);
        if (!response.ok) {
          setError('Search is unavailable right now.');
          setSearchResults([]);
          return;
        }

        const data = await response.json();
        if (data.error) {
          setError(data.error);
          setSearchResults([]);
          return;
        }

        const serverResults: SearchResult[] = data.results ?? [];
        const agentResults = searchAgentsLocally(query.trim(), agentsJson);
        const merged = [...agentResults, ...serverResults].sort((a, b) => b.score - a.score);
        setSearchResults(merged.slice(0, 25));
        setSelectedIndex(0);
      } catch {
        setError('Search failed. Check the connection and try again.');
        setSearchResults([]);
      } finally {
        setLoading(false);
      }
    }, 280);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [agentsJson, query, repo, retryNonce, workspace]);

  const actionItems = useMemo<PaletteItem[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return actions
      .map((action) => ({ action, score: actionMatchScore(action, normalizedQuery) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, normalizedQuery ? 12 : 10)
      .map(({ action, score }) => {
        const meta = ACTION_META[action.category];
        return {
          id: action.id,
          itemKind: 'action' as const,
          title: action.title,
          detail: action.detail,
          badge: meta.badge,
          color: meta.color,
          Icon: meta.Icon,
          section: meta.section,
          shortcut: action.shortcut,
          score,
          closeOnRun: action.closeOnRun ?? true,
          stateLabel: action.stateLabel,
          stateTone: action.stateTone,
          disabled: Boolean(action.disabled),
          unavailableReason: action.unavailableReason,
          run: action.run,
        };
      });
  }, [actions, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const searchItems: PaletteItem[] = searchResults.map((result, index) => ({
      id: `search:${result.kind}:${result.title}:${index}`,
      itemKind: 'search',
      title: result.title,
      detail: result.detail,
      badge: KIND_LABEL[result.kind],
      color: KIND_COLOR[result.kind],
      Icon: KIND_ICON[result.kind],
      section: 'Search results',
      score: result.score,
      target: result.target,
    }));

    if (!query.trim() || query.trim().length < 2) {
      return actionItems;
    }

    return [...actionItems, ...searchItems].slice(0, 25);
  }, [actionItems, query, searchResults]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= items.length) {
      setSelectedIndex(0);
    }
  }, [items.length, selectedIndex]);

  const handleSearchSelect = useCallback((target?: SearchTarget) => {
    if (!target) return;

    if (target.sessionKey && onSelectSession) {
      onSelectSession(target.sessionKey);
    } else if (target.issueNumber && onSelectIssue) {
      onSelectIssue(target.issueNumber);
    } else if (target.filePath && onSelectFile) {
      onSelectFile(target.filePath, target.line ?? undefined);
    }

    setQuery('');
    setSearchResults([]);
    if (onClose) onClose();
  }, [onClose, onSelectFile, onSelectIssue, onSelectSession]);

  const handleSelect = useCallback(async (item: PaletteItem) => {
    if (item.itemKind === 'action') {
      if (item.disabled) {
        setError(item.unavailableReason || `${item.title} is not available here yet.`);
        return;
      }
      setActionBusyId(item.id);
      setError(null);
      try {
        await item.run();
        setQuery('');
        setSearchResults([]);
        if (item.closeOnRun && onClose) {
          onClose();
        }
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'Action failed.');
      } finally {
        setActionBusyId(null);
      }
      return;
    }

    handleSearchSelect(item.target);
  }, [handleSearchSelect, onClose]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(items.length - 1, 0)));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter' && items[selectedIndex]) {
      event.preventDefault();
      void handleSelect(items[selectedIndex]);
      return;
    }

    if (event.key === 'Escape') {
      setQuery('');
      setSearchResults([]);
      inputRef.current?.blur();
    }
  }, [handleSelect, items, selectedIndex]);

  useEffect(() => {
    if (isMobile) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const handleGlobalKey = (event: KeyboardEvent) => {
      const isCommandPaletteShortcut =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      const isShiftPaletteShortcut =
        (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p';

      if (!isCommandPaletteShortcut && !isShiftPaletteShortcut) {
        return;
      }

      event.preventDefault();
      inputRef.current?.focus();
      setFocused(true);
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, [isMobile]);

  const showDropdown = (focused || isMobile) && (items.length > 0 || loading || error);
  const isEmpty = !loading && !error && query.trim().length > 0 && items.length === 0;
  const emptyMessage = query.trim().length < 2
    ? `No commands match "${query.trim()}". Keep typing to search sessions, files, and reviews.`
    : `No results for "${query.trim()}".`;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: isMobile ? undefined : 560,
        margin: isMobile ? 0 : '0 auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: isMobile ? '10px 14px' : '8px 14px',
          borderRadius: 12,
          background: isMobile
            ? 'rgba(120, 120, 128, 0.12)'
            : focused
              ? 'rgba(255, 255, 255, 0.9)'
              : 'rgba(255, 255, 255, 0.5)',
          backdropFilter: isMobile ? 'none' : 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: isMobile ? 'none' : 'blur(20px) saturate(1.6)',
          border: isMobile
            ? 'none'
            : focused
              ? '1px solid rgba(37, 99, 235, 0.24)'
              : '1px solid rgba(15, 23, 42, 0.06)',
          boxShadow: !isMobile && focused ? '0 12px 32px rgba(15, 23, 42, 0.08)' : 'none',
          transition: 'all 200ms ease',
        }}
      >
        <Search
          size={isMobile ? 16 : 14}
          strokeWidth={1.8}
          style={{ color: '#64748b', flexShrink: 0 }}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={isMobile ? 'Search everything…' : 'Jump to a session, run a command, or search…'}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontSize: isMobile ? 16 : 13,
            color: isMobile ? '#111827' : '#0f172a',
            fontFamily: '-apple-system, system-ui, sans-serif',
            fontWeight: 400,
            letterSpacing: '-0.01em',
            WebkitAppearance: 'none',
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setSearchResults([]);
              setError(null);
              inputRef.current?.focus();
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'rgba(120, 120, 128, 0.12)',
              borderRadius: 10,
              padding: 4,
              cursor: 'pointer',
              color: '#64748b',
              minWidth: 22,
              minHeight: 22,
            }}
          >
            <X size={12} strokeWidth={2.4} />
          </button>
        ) : !isMobile ? (
          <kbd
            style={{
              fontSize: 10,
              color: '#64748b',
              background: 'rgba(15, 23, 42, 0.06)',
              padding: '2px 5px',
              borderRadius: 4,
              fontFamily: '-apple-system, system-ui, sans-serif',
              fontWeight: 600,
            }}
          >
            ⌘K
          </kbd>
        ) : null}
      </div>

      {showDropdown ? (
        <div
          style={{
            position: isMobile ? 'relative' : 'absolute',
            top: isMobile ? 0 : 'calc(100% + 8px)',
            left: 0,
            right: 0,
            maxHeight: isMobile ? 340 : 460,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            borderRadius: isMobile ? 0 : 16,
            background: isMobile ? 'transparent' : 'rgba(255, 255, 255, 0.94)',
            backdropFilter: isMobile ? 'none' : 'blur(28px) saturate(1.8)',
            WebkitBackdropFilter: isMobile ? 'none' : 'blur(28px) saturate(1.8)',
            border: isMobile ? 'none' : '1px solid rgba(15, 23, 42, 0.08)',
            boxShadow: isMobile ? 'none' : '0 24px 64px rgba(15, 23, 42, 0.14), 0 4px 12px rgba(15, 23, 42, 0.06)',
            zIndex: 100,
            marginTop: isMobile ? 8 : 0,
            padding: isMobile ? 0 : '6px',
          }}
        >
          {error ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                justifyContent: 'space-between',
                padding: isMobile ? '12px 0' : '10px 12px',
                color: '#b91c1c',
                fontSize: 12,
                borderBottom: items.length > 0 ? '1px solid rgba(15, 23, 42, 0.06)' : 'none',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <AlertCircle size={14} strokeWidth={2} />
                <span style={{ minWidth: 0 }}>{error}</span>
              </span>
              {query.trim().length >= 2 ? (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setRetryNonce(retrySearchBump);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    border: 'none',
                    background: 'rgba(185, 28, 28, 0.08)',
                    color: '#b91c1c',
                    borderRadius: 999,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  <RefreshCw size={11} strokeWidth={2.2} />
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}

          {loading && searchResults.length === 0 ? (
            <div
              style={{
                padding: isMobile ? '12px 0' : '12px 14px',
                fontSize: 12,
                color: '#64748b',
              }}
            >
              Searching sessions, issues, files, and symbols…
            </div>
          ) : null}

          {items.map((item, index) => {
            const isSelected = !isMobile && index === selectedIndex;
            const showSection = index === 0 || items[index - 1]?.section !== item.section;
            const isActionBusy = actionBusyId === item.id;
            const actionState = item.itemKind === 'action' && item.stateLabel && item.stateTone
              ? ACTION_STATE_META[item.stateTone]
              : null;
            const isDisabled = item.itemKind === 'action' ? item.disabled : false;

            return (
              <div key={item.id}>
                {showSection ? (
                  <div
                    style={{
                      padding: isMobile ? '10px 0 6px' : index === 0 ? '6px 10px 8px' : '12px 10px 8px',
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#64748b',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {item.section}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => { void handleSelect(item); }}
                  onMouseEnter={() => !isMobile && setSelectedIndex(index)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    width: '100%',
                    padding: isMobile ? '12px 0' : '10px 12px',
                    border: 'none',
                    borderRadius: isMobile ? 0 : 12,
                    background: isSelected ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                    cursor: isDisabled ? 'default' : 'pointer',
                    textAlign: 'left',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    transition: 'background 90ms ease',
                    WebkitTapHighlightColor: 'transparent',
                    minHeight: 48,
                    opacity: isDisabled ? 0.68 : 1,
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 10,
                      background: `${item.color}16`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    <item.Icon size={15} strokeWidth={2} style={{ color: item.color }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: '#0f172a',
                          lineHeight: 1.3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        {item.title}
                      </span>
                      {actionState && item.itemKind === 'action' ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: actionState.color,
                            background: actionState.background,
                            padding: '2px 6px',
                            borderRadius: 999,
                            flexShrink: 0,
                            letterSpacing: '-0.01em',
                          }}
                        >
                          {item.stateLabel}
                        </span>
                      ) : null}
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: item.color,
                          background: `${item.color}14`,
                          padding: '2px 6px',
                          borderRadius: 999,
                          flexShrink: 0,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {item.badge}
                      </span>
                      {'shortcut' in item && item.shortcut ? (
                        <kbd
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#64748b',
                            background: 'rgba(15, 23, 42, 0.06)',
                            padding: '2px 6px',
                            borderRadius: 6,
                            flexShrink: 0,
                          }}
                        >
                          {item.shortcut}
                        </kbd>
                      ) : null}
                    </div>
                    {item.detail ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: '#64748b',
                          lineHeight: 1.4,
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {isActionBusy ? 'Running…' : item.detail}
                      </div>
                    ) : null}
                    {isDisabled && item.itemKind === 'action' && item.unavailableReason ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#94a3b8',
                          lineHeight: 1.4,
                          marginTop: 3,
                        }}
                      >
                        {item.unavailableReason}
                      </div>
                    ) : null}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {isEmpty ? (
        <div
          style={{
            padding: isMobile ? '16px 0' : '16px 18px',
            fontSize: 13,
            color: '#94a3b8',
            textAlign: 'center',
            ...(isMobile ? {} : {
              position: 'absolute' as const,
              top: 'calc(100% + 8px)',
              left: 0,
              right: 0,
              borderRadius: 16,
              background: 'rgba(255, 255, 255, 0.94)',
              backdropFilter: 'blur(28px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(28px) saturate(1.8)',
              border: '1px solid rgba(15, 23, 42, 0.08)',
              boxShadow: '0 24px 64px rgba(15, 23, 42, 0.12)',
              zIndex: 100,
            }),
          }}
        >
          {emptyMessage}
        </div>
      ) : null}
    </div>
  );
});
