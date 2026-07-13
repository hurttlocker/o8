'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertGlyph,
  CloseGlyph,
  PaletteList,
  SearchGlyph,
  type PaletteIconKind,
  type PaletteListItem,
} from './command-palette/PaletteList';
import {
  cardStyle,
  clearButtonStyle,
  errorRowStyle,
  footerStyle,
  inputRowStyle,
  inputStyle,
  kbdStyle,
  listStyle,
  overlayStyle,
  scopePillStyle,
  scopeRowStyle,
  statusRowStyle,
  type GroupKey,
} from './command-palette-styles';

export type CommandPaletteSearchKind = 'issue' | 'file' | 'agent' | 'chat' | 'directive';

export interface CommandPaletteSearchTarget {
  issueNumber?: number;
  repo?: string;
  filePath?: string;
  line?: number;
  sessionKey?: string;
  chatTabId?: string;
  directiveId?: string;
}

export interface CommandPaletteSearchResult {
  kind: CommandPaletteSearchKind;
  id: string;
  title: string;
  detail: string;
  target?: CommandPaletteSearchTarget;
  score: number;
}

export interface CommandPaletteRecent {
  id: string;
  kind: CommandPaletteSearchKind;
  title: string;
  detail?: string;
  target: CommandPaletteSearchTarget;
  lastUsedAt: number;
}

export interface CommandPaletteActionItem {
  id: string;
  title: string;
  detail?: string;
  shortcut?: string;
  swatchColor?: string;
  onActivate: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  workspace?: string | null;
  repo?: string | null;
  actionItems?: CommandPaletteActionItem[];
  onSelectIssue: (issueNumber: number, repo?: string) => void;
  onSelectFile: (filePath: string, line?: number) => void;
  onSelectAgent: (sessionKey: string) => void;
  onSelectChat?: (chatTabId: string, title?: string) => void;
  onSelectDirective?: (directiveId: string) => void;
}

type PaletteScope = 'all' | 'agent' | 'file' | 'action' | 'issue' | 'chat' | 'directive';
type FilterScope = Exclude<PaletteScope, 'all'>;

interface PaletteItem extends PaletteListItem {
  groupKey: GroupKey;
  scope: FilterScope;
  detail: string;
  result?: CommandPaletteSearchResult;
  onActivate?: () => void;
}

interface SearchResponse {
  query: string;
  results: CommandPaletteSearchResult[];
  groups: Record<CommandPaletteSearchKind, CommandPaletteSearchResult[]>;
  error?: string;
}

const RECENTS_KEY = 'o8:command-palette:recents:v1';
const RECENTS_MAX = 8;
const DEBOUNCE_MS = 200;
const SPRING = { type: 'spring' as const, stiffness: 400, damping: 30 };
const EMPTY_GROUPS: Record<CommandPaletteSearchKind, CommandPaletteSearchResult[]> = {
  issue: [],
  file: [],
  agent: [],
  chat: [],
  directive: [],
};

const SCOPE_TABS: Array<{ id: PaletteScope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Agents' },
  { id: 'file', label: 'Files' },
  { id: 'action', label: 'Actions' },
  { id: 'issue', label: 'Issues' },
  { id: 'chat', label: 'Chats' },
  { id: 'directive', label: 'Rules' },
];

const KIND_ICON: Record<CommandPaletteSearchKind, PaletteIconKind> = {
  issue: 'issue',
  file: 'file',
  agent: 'agent',
  chat: 'chat',
  directive: 'directive',
};

function isSearchKind(value: unknown): value is CommandPaletteSearchKind {
  return value === 'issue'
    || value === 'file'
    || value === 'agent'
    || value === 'chat'
    || value === 'directive';
}

function readRecents(): CommandPaletteRecent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is CommandPaletteRecent => (
        Boolean(entry)
        && typeof entry.id === 'string'
        && typeof entry.title === 'string'
        && typeof entry.lastUsedAt === 'number'
        && isSearchKind(entry.kind)
        && Boolean(entry.target)
        && typeof entry.target === 'object'
      ))
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function writeRecents(entries: CommandPaletteRecent[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(entries.slice(0, RECENTS_MAX)));
  } catch {
    // Storage is best-effort; navigation still succeeds when it is unavailable.
  }
}

function pushRecent(entry: Omit<CommandPaletteRecent, 'lastUsedAt'>): CommandPaletteRecent[] {
  const current = readRecents();
  const next = [
    { ...entry, lastUsedAt: Date.now() },
    ...current.filter((existing) => existing.id !== entry.id),
  ].slice(0, RECENTS_MAX);
  writeRecents(next);
  return next;
}

function relativeTimestamp(timestamp: number | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function chatTimestamp(result: CommandPaletteSearchResult): number | null {
  const source = result.target?.chatTabId ?? result.id;
  const match = source.match(/(?:^|\D)(\d{13})(?:\D|$)/);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function dirname(path: string): string {
  const normalized = path.replace(/^\.\//, '');
  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/') || '.';
}

function resultMeta(result: CommandPaletteSearchResult): string {
  if (result.kind === 'file') {
    const separatorIndex = result.detail.indexOf(' · ');
    if (separatorIndex >= 0) {
      const repoName = result.detail.slice(0, separatorIndex);
      const relativePath = result.detail.slice(separatorIndex + 3);
      return `${repoName} · ${dirname(relativePath)}`;
    }
    return dirname(result.target?.filePath ?? result.detail);
  }
  if (result.kind === 'chat') return relativeTimestamp(chatTimestamp(result)) || result.detail;
  return result.detail;
}

function paletteItemForResult(result: CommandPaletteSearchResult): PaletteItem {
  return {
    id: result.id,
    groupKey: result.kind,
    scope: result.kind,
    title: result.title,
    detail: result.detail,
    meta: resultMeta(result),
    iconKind: KIND_ICON[result.kind],
    result,
  };
}

export const CommandPalette = memo(function CommandPalette({
  open,
  onClose,
  workspace,
  repo,
  actionItems,
  onSelectIssue,
  onSelectFile,
  onSelectAgent,
  onSelectChat,
  onSelectDirective,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PaletteScope>('all');
  const [groups, setGroups] = useState<Record<CommandPaletteSearchKind, CommandPaletteSearchResult[]>>(EMPTY_GROUPS);
  const [recents, setRecents] = useState<CommandPaletteRecent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndexRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setScope('all');
    setGroups(EMPTY_GROUPS);
    setRecents(readRecents());
    setLoading(false);
    setError(null);
    setSelectedIndex(0);
    const focusId = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusId);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    const trimmed = query.trim();
    const browseScope = scope === 'agent'
      || scope === 'file'
      || scope === 'issue'
      || scope === 'chat'
      || scope === 'directive'
      ? scope
      : null;
    if (trimmed.length < 2 && !browseScope) {
      setGroups(EMPTY_GROUPS);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const params = new URLSearchParams({ q: trimmed });
        if (workspace) params.set('workspace', workspace);
        if (repo) params.set('repo', repo);
        if (browseScope) params.set('scope', browseScope);
        const response = await fetch(`/api/panel/search?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) {
          setError('Search is unavailable.');
          setGroups(EMPTY_GROUPS);
          return;
        }
        const data = await response.json() as SearchResponse;
        if (data.error) {
          setError(data.error);
          setGroups(EMPTY_GROUPS);
          return;
        }
        setGroups(data.groups ?? EMPTY_GROUPS);
        setError(null);
      } catch (caught) {
        if ((caught as { name?: string })?.name === 'AbortError') return;
        setError('Search failed.');
        setGroups(EMPTY_GROUPS);
      } finally {
        setLoading(false);
      }
    }, trimmed.length < 2 ? 0 : DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [open, query, repo, scope, workspace]);

  const filteredActionItems = useMemo<PaletteItem[]>(() => {
    if (!actionItems?.length) return [];
    const trimmed = query.trim().toLowerCase();
    const source = trimmed.length === 0
      ? actionItems.filter((entry) => !entry.id.startsWith('project:move:'))
      : actionItems.filter((entry) => (
          entry.title.toLowerCase().includes(trimmed)
          || (entry.detail ?? '').toLowerCase().includes(trimmed)
        ));
    return source.map((entry) => ({
      id: entry.id,
      groupKey: 'action',
      scope: 'action',
      title: entry.title,
      detail: entry.detail ?? '',
      meta: entry.shortcut ?? entry.detail ?? '',
      iconKind: 'action',
      onActivate: entry.onActivate,
      swatchColor: entry.swatchColor,
    }));
  }, [actionItems, query]);

  const unscopedItems = useMemo<PaletteItem[]>(() => {
    if (query.trim().length < 2) {
      if (scope !== 'all' && scope !== 'action') {
        return groups[scope].map(paletteItemForResult);
      }
      const recentItems = recents.map<PaletteItem>((entry) => ({
        id: `recent:${entry.id}`,
        groupKey: 'recent',
        scope: entry.kind,
        title: entry.title,
        detail: entry.detail ?? '',
        meta: relativeTimestamp(entry.lastUsedAt),
        iconKind: KIND_ICON[entry.kind],
        result: {
          kind: entry.kind,
          id: entry.id,
          title: entry.title,
          detail: entry.detail ?? '',
          target: entry.target,
          score: 0,
        },
      }));
      return scope === 'action' ? filteredActionItems : [...recentItems, ...filteredActionItems];
    }

    const ordered: PaletteItem[] = [...filteredActionItems];
    const appendGroup = (kind: CommandPaletteSearchKind) => {
      for (const result of groups[kind]) {
        ordered.push(paletteItemForResult(result));
      }
    };
    appendGroup('agent');
    appendGroup('issue');
    appendGroup('file');
    appendGroup('chat');
    appendGroup('directive');
    return ordered;
  }, [filteredActionItems, groups, query, recents, scope]);

  const items = useMemo(
    () => scope === 'all' ? unscopedItems : unscopedItems.filter((item) => item.scope === scope),
    [scope, unscopedItems],
  );

  useEffect(() => {
    if (items.length === 0 || selectedIndex >= items.length) setSelectedIndex(0);
  }, [items.length, selectedIndex]);

  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${selectedIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [items.length, selectedIndex]);

  const handleActivate = useCallback((item: PaletteItem) => {
    if (item.groupKey === 'action') {
      item.onActivate?.();
      onClose();
      return;
    }
    const target = item.result?.target;
    if (!target || !item.result) return;

    if (item.scope !== 'agent') {
      setRecents(pushRecent({
        id: item.result.id,
        kind: item.result.kind,
        title: item.title,
        detail: item.detail,
        target,
      }));
    }

    if (target.issueNumber !== undefined) {
      onSelectIssue(target.issueNumber, target.repo);
    } else if (target.filePath) {
      onSelectFile(target.filePath, target.line);
    } else if (target.sessionKey) {
      onSelectAgent(target.sessionKey);
    } else if (target.chatTabId) {
      if (onSelectChat) {
        onSelectChat(target.chatTabId, item.title);
      } else if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('o8:command-palette:open-chat', {
          detail: { chatTabId: target.chatTabId, title: item.title },
        }));
      }
    } else if (target.directiveId) {
      if (onSelectDirective) {
        onSelectDirective(target.directiveId);
      } else if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('o8:command-palette:open-directive', {
          detail: { directiveId: target.directiveId, title: item.title },
        }));
      }
    }
    onClose();
  }, [onClose, onSelectAgent, onSelectChat, onSelectDirective, onSelectFile, onSelectIssue]);

  const chooseScope = useCallback((nextScope: PaletteScope) => {
    setScope(nextScope);
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const currentIndex = SCOPE_TABS.findIndex((tab) => tab.id === scope);
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (currentIndex + direction + SCOPE_TABS.length) % SCOPE_TABS.length;
      chooseScope(SCOPE_TABS[nextIndex].id);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => items.length === 0 ? 0 : Math.min(current + 1, items.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[selectedIndexRef.current];
      if (item) handleActivate(item);
    }
  }, [chooseScope, handleActivate, items, onClose, scope]);

  const trimmed = query.trim();
  const showEmpty = !loading && !error && items.length === 0;

  return (
    <AnimatePresence>
      <motion.div
        key="palette-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={onClose}
        style={overlayStyle}
        role="presentation"
      >
        <motion.div
          key="palette-card"
          initial={{ opacity: 0, scale: 0.96, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          transition={SPRING}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleKeyDown}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          style={cardStyle}
        >
          <div style={inputRowStyle}>
            <SearchGlyph />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedIndex(0);
              }}
              placeholder="Search agents, files, actions..."
              spellCheck={false}
              autoComplete="off"
              style={inputStyle}
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setSelectedIndex(0);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                style={clearButtonStyle}
              >
                <CloseGlyph />
              </button>
            ) : (
              <kbd style={kbdStyle}>esc</kbd>
            )}
          </div>

          <div style={scopeRowStyle} aria-label="Search scope">
            {SCOPE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={scope === tab.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseScope(tab.id)}
                style={scopePillStyle(scope === tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div ref={listRef} style={listStyle}>
            {error ? (
              <div style={errorRowStyle}>
                <AlertGlyph />
                <span>{error}</span>
              </div>
            ) : null}

            {loading && items.length === 0 ? <div style={statusRowStyle}>Searching…</div> : null}

            {showEmpty ? (
              <div style={statusRowStyle}>
                {trimmed.length < 2
                  ? scope === 'file'
                    ? 'Type to search files.'
                    : scope === 'all'
                      ? 'No recent items or available actions.'
                      : `No ${SCOPE_TABS.find((tab) => tab.id === scope)?.label.toLowerCase() ?? 'items'} yet.`
                  : `No ${scope === 'all' ? 'results' : SCOPE_TABS.find((tab) => tab.id === scope)?.label.toLowerCase()} for “${trimmed}”.`}
              </div>
            ) : null}

            {items.length > 0 ? (
              <PaletteList
                items={items}
                selectedIndex={selectedIndex}
                onHover={setSelectedIndex}
                onActivate={(index) => {
                  const item = items[index];
                  if (item) handleActivate(item);
                }}
              />
            ) : null}
          </div>

          <div style={footerStyle}>
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>tab filter</span>
            <span>esc close</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
});
