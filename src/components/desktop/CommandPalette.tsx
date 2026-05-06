'use client';

/**
 * CommandPalette — full-screen overlay command palette (Cmd+K / Ctrl+K).
 *
 * Issue #661. Distinct from `UniversalSearch` (which is the inline search
 * bar in the TitleBar). This component renders as a modal overlay over the
 * whole desktop dashboard, with grouped fan-out search results and a
 * client-side LRU of recents (localStorage).
 *
 * Spec:
 *   - Autofocus input on open
 *   - Empty query → "Recent" group from localStorage LRU
 *   - Type ≥2 chars → debounce 200ms → grouped results across Issues / Files
 *     / Agents
 *   - ↑/↓ navigate, Enter selects, Esc closes
 *   - The dashboard owns the global Cmd+K listener and toggles `open`
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  ChevronRight,
  Clock,
  FileText,
  GitPullRequestDraft,
  Monitor,
  Search,
  X,
  type LucideIcon,
} from '@/components/desktop/lucide-shims';
import {
  KIND_COLOR,
  cardStyle,
  clearButtonStyle,
  detailTextStyle,
  errorRowStyle,
  footerHintGroupStyle,
  footerHintTextStyle,
  footerKbdStyle,
  footerSpacerStyle,
  footerStyle,
  groupBadgeStyle,
  iconWrapStyle,
  inputRowStyle,
  inputStyle,
  kbdStyle,
  listStyle,
  overlayStyle,
  rowStyleBase,
  sectionHeaderStyle,
  statusRowStyle,
  titleColumnStyle,
  titleTextStyle,
  type GroupKey,
} from './command-palette-styles';

// ── Types ──────────────────────────────────────────────────────────────────

export type CommandPaletteSearchKind = 'issue' | 'file' | 'agent';

export interface CommandPaletteSearchTarget {
  issueNumber?: number;
  repo?: string;
  filePath?: string;
  line?: number;
  sessionKey?: string;
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
  /** ms epoch timestamp of last activation. */
  lastUsedAt: number;
}

/**
 * Action items are client-side palette entries that don't go through the
 * server search — used today for "Switch to project" / "Move repo to
 * project" rows. The host wires `onActivate` directly so the palette never
 * needs to know which subsystem is being driven.
 */
export interface CommandPaletteActionItem {
  /** Stable id (eg "project:switch:default"). Used for keyboard nav and as
   *  the React key. */
  id: string;
  title: string;
  detail?: string;
  /** Optional swatch color rendered inside the icon slot. Used for project
   *  rows so the palette mirrors the dot color in the bottom bar. */
  swatchColor?: string;
  onActivate: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Active workspace path, forwarded to the search route for file scoping. */
  workspace?: string | null;
  /** Active repo slug or short name for issue scoping. */
  repo?: string | null;
  /** Client-side rows that bypass the search index (project switch / move). */
  actionItems?: CommandPaletteActionItem[];
  onSelectIssue: (issueNumber: number, repo?: string) => void;
  onSelectFile: (filePath: string, line?: number) => void;
  onSelectAgent: (sessionKey: string) => void;
}

interface PaletteItem {
  id: string;
  groupKey: GroupKey;
  title: string;
  detail: string;
  Icon: LucideIcon;
  iconColor: string;
  /** Defined for search-backed rows. Action rows use `onActivate` instead. */
  result?: CommandPaletteSearchResult;
  /** Defined for client-side action rows. */
  onActivate?: () => void;
  /** Solid swatch color rendered in place of an icon. */
  swatchColor?: string;
}

interface SearchResponse {
  query: string;
  results: CommandPaletteSearchResult[];
  groups: Record<CommandPaletteSearchKind, CommandPaletteSearchResult[]>;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const RECENTS_KEY = 'o8:command-palette:recents:v1';
const RECENTS_MAX = 8;
const DEBOUNCE_MS = 200;
const SPRING = { type: 'spring' as const, stiffness: 400, damping: 30 };

const KIND_ICON: Record<CommandPaletteSearchKind, LucideIcon> = {
  issue: GitPullRequestDraft,
  file: FileText,
  agent: Monitor,
};

const GROUP_LABEL: Record<GroupKey, string> = {
  recent: 'Recent',
  issue: 'Issues',
  file: 'Files',
  agent: 'Agents',
  action: 'Actions',
};

// ── localStorage LRU helpers ───────────────────────────────────────────────

function readRecents(): CommandPaletteRecent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is CommandPaletteRecent => (
        entry
        && typeof entry.id === 'string'
        && typeof entry.title === 'string'
        && typeof entry.lastUsedAt === 'number'
        && (entry.kind === 'issue' || entry.kind === 'file' || entry.kind === 'agent')
        && entry.target
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
    // ignore quota / disabled storage
  }
}

function pushRecent(entry: Omit<CommandPaletteRecent, 'lastUsedAt'>): CommandPaletteRecent[] {
  const now = Date.now();
  const current = readRecents();
  const dedup = current.filter((existing) => existing.id !== entry.id);
  const next: CommandPaletteRecent[] = [{ ...entry, lastUsedAt: now }, ...dedup].slice(
    0,
    RECENTS_MAX,
  );
  writeRecents(next);
  return next;
}

// ── Component ──────────────────────────────────────────────────────────────

export const CommandPalette = memo(function CommandPalette({
  open,
  onClose,
  workspace,
  repo,
  actionItems,
  onSelectIssue,
  onSelectFile,
  onSelectAgent,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Record<CommandPaletteSearchKind, CommandPaletteSearchResult[]>>(
    { issue: [], file: [], agent: [] },
  );
  const [recents, setRecents] = useState<CommandPaletteRecent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndexRef = useRef(selectedIndex);

  // Reset state on open and refresh recents from localStorage.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setGroups({ issue: [], file: [], agent: [] });
    setError(null);
    setLoading(false);
    setSelectedIndex(0);
    setRecents(readRecents());
    // autofocus on the next tick so the overlay is mounted first
    const handle = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  // Debounced search — 200ms per spec.
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
    if (trimmed.length < 2) {
      setGroups({ issue: [], file: [], agent: [] });
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
        const response = await fetch(`/api/panel/search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          setError('Search is unavailable.');
          setGroups({ issue: [], file: [], agent: [] });
          return;
        }
        const data = await response.json() as SearchResponse;
        if (data.error) {
          setError(data.error);
          setGroups({ issue: [], file: [], agent: [] });
          return;
        }
        setGroups(data.groups ?? { issue: [], file: [], agent: [] });
        setError(null);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError('Search failed.');
        setGroups({ issue: [], file: [], agent: [] });
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [open, query, workspace, repo]);

  // Filter client-side action items by the current query so the palette
  // surfaces "Switch to Marketing" when the operator types "marketing", but
  // keeps them out of the way at rest.
  const filteredActionItems = useMemo<PaletteItem[]>(() => {
    if (!actionItems?.length) return [];
    const trimmed = query.trim().toLowerCase();
    const source = trimmed.length === 0
      ? actionItems
      : actionItems.filter((entry) => (
        entry.title.toLowerCase().includes(trimmed)
        || (entry.detail ?? '').toLowerCase().includes(trimmed)
      ));
    return source.map((entry) => ({
      id: entry.id,
      groupKey: 'action' as const,
      title: entry.title,
      detail: entry.detail ?? '',
      Icon: ChevronRight,
      iconColor: 'var(--t-text-muted)',
      onActivate: entry.onActivate,
      swatchColor: entry.swatchColor,
    }));
  }, [actionItems, query]);

  // Build the flat ordered item list (used for keyboard navigation +
  // selection mapping). Sections render off the same array.
  const items = useMemo<PaletteItem[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      // Empty query → show actions + recents
      const recentItems: PaletteItem[] = recents.map((entry) => ({
        id: `recent:${entry.id}`,
        groupKey: 'recent' as const,
        title: entry.title,
        detail: entry.detail ?? '',
        Icon: KIND_ICON[entry.kind] ?? Clock,
        iconColor: KIND_COLOR[entry.kind] ?? '#64748b',
        result: {
          kind: entry.kind,
          id: entry.id,
          title: entry.title,
          detail: entry.detail ?? '',
          target: entry.target,
          score: 0,
        },
      }));
      return [...filteredActionItems, ...recentItems];
    }

    const ordered: PaletteItem[] = [];
    // Actions first so frequent project switches stay above search noise.
    ordered.push(...filteredActionItems);
    const pushGroup = (kind: CommandPaletteSearchKind) => {
      for (const result of groups[kind]) {
        ordered.push({
          id: result.id,
          groupKey: kind,
          title: result.title,
          detail: result.detail,
          Icon: KIND_ICON[kind],
          iconColor: KIND_COLOR[kind],
          result,
        });
      }
    };
    pushGroup('agent');
    pushGroup('issue');
    pushGroup('file');
    return ordered;
  }, [filteredActionItems, groups, query, recents]);

  // Keep selectedIndex in bounds when items shrink.
  useEffect(() => {
    if (selectedIndex >= items.length && items.length > 0) {
      setSelectedIndex(0);
    }
  }, [items.length, selectedIndex]);

  // Sync selectedIndexRef so the Enter handler always reads the latest index
  // without closing over a stale value.
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // Scroll the active item into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-palette-index="${selectedIndex}"]`);
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, items.length]);

  const handleActivate = useCallback((item: PaletteItem) => {
    if (item.groupKey === 'action') {
      item.onActivate?.();
      onClose();
      return;
    }
    const target = item.result?.target;
    if (!target || !item.result) return;

    // Promote to recents (best-effort). For agents we skip recents because
    // sessionKeys are short-lived and stale entries would be useless.
    if (item.groupKey !== 'agent') {
      const next = pushRecent({
        id: item.result.id,
        kind: item.result.kind,
        title: item.title,
        detail: item.detail,
        target,
      });
      setRecents(next);
    }

    if (target.issueNumber !== undefined) {
      onSelectIssue(target.issueNumber, target.repo);
    } else if (target.filePath) {
      onSelectFile(target.filePath, target.line);
    } else if (target.sessionKey) {
      onSelectAgent(target.sessionKey);
    }
    onClose();
  }, [onClose, onSelectAgent, onSelectFile, onSelectIssue]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => {
        if (items.length === 0) return 0;
        return Math.min(current + 1, items.length - 1);
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = items[selectedIndexRef.current];
      if (target) handleActivate(target);
    }
  }, [handleActivate, items, onClose]);

  const showEmpty = !loading && !error && items.length === 0;
  const trimmed = query.trim();

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
            <Search size={16} strokeWidth={1.8} color="var(--t-text-muted)" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search issues, files, agents…"
              spellCheck={false}
              autoComplete="off"
              style={inputStyle}
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                style={clearButtonStyle}
              >
                <X size={12} strokeWidth={2.2} color="var(--t-text-muted)" />
              </button>
            ) : (
              <kbd style={kbdStyle}>esc</kbd>
            )}
          </div>

          <div ref={listRef} style={listStyle}>
            {error ? (
              <div style={errorRowStyle}>
                <AlertCircle size={14} strokeWidth={2} color="var(--t-danger, #ef4444)" />
                <span>{error}</span>
              </div>
            ) : null}

            {loading && items.length === 0 ? (
              <div style={statusRowStyle}>Searching…</div>
            ) : null}

            {showEmpty ? (
              <div style={statusRowStyle}>
                {trimmed.length < 2
                  ? 'Type to search issues, files, and agents.'
                  : `No results for "${trimmed}".`}
              </div>
            ) : null}

            {items.length > 0 ? (
              <PaletteList
                items={items}
                selectedIndex={selectedIndex}
                onHover={setSelectedIndex}
                onActivate={handleActivate}
              />
            ) : null}
          </div>

          <div style={footerStyle}>
            <FooterHint label="Move" combo={['↑', '↓']} />
            <FooterHint label="Open" combo={['↵']} />
            <FooterHint label="Close" combo={['esc']} />
            <span style={footerSpacerStyle} />
            <span style={footerHintTextStyle}>
              <ArrowRight size={11} strokeWidth={1.8} color="var(--t-text-faint)" />
              {trimmed.length < 2
                ? `${recents.length} recent`
                : `${items.length} result${items.length === 1 ? '' : 's'}`}
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
});

// ── Subcomponents ──────────────────────────────────────────────────────────

const PaletteList = memo(function PaletteList({
  items,
  selectedIndex,
  onHover,
  onActivate,
}: {
  items: PaletteItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onActivate: (item: PaletteItem) => void;
}) {
  // Group consecutive items by groupKey so each section renders one header.
  const sections: Array<{ key: GroupKey; start: number; entries: PaletteItem[] }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const last = sections[sections.length - 1];
    if (!last || last.key !== item.groupKey) {
      sections.push({ key: item.groupKey, start: i, entries: [item] });
    } else {
      last.entries.push(item);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {sections.map((section) => (
        <div key={`section-${section.start}-${section.key}`}>
          <div style={sectionHeaderStyle}>{GROUP_LABEL[section.key]}</div>
          {section.entries.map((item, offset) => {
            const flatIndex = section.start + offset;
            const isSelected = flatIndex === selectedIndex;
            return (
              <button
                key={item.id}
                type="button"
                data-palette-index={flatIndex}
                onClick={() => onActivate(item)}
                onMouseEnter={() => onHover(flatIndex)}
                style={{
                  ...rowStyleBase,
                  background: isSelected ? 'var(--t-panel-active, rgba(37,99,235,0.1))' : 'transparent',
                }}
              >
                <span style={iconWrapStyle}>
                  {item.swatchColor ? (
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        background: item.swatchColor,
                      }}
                    />
                  ) : (
                    <item.Icon size={14} strokeWidth={1.7} color={item.iconColor} />
                  )}
                </span>
                <span style={titleColumnStyle}>
                  <span style={titleTextStyle}>{item.title}</span>
                  {item.detail ? (
                    <span style={detailTextStyle}>{item.detail}</span>
                  ) : null}
                </span>
                <span style={groupBadgeStyle(item.groupKey)}>
                  {GROUP_LABEL[item.groupKey]}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});

function FooterHint({ label, combo }: { label: string; combo: string[] }) {
  return (
    <span style={footerHintGroupStyle}>
      {combo.map((key) => (
        <kbd key={key} style={footerKbdStyle}>{key}</kbd>
      ))}
      <span style={footerHintTextStyle}>{label}</span>
    </span>
  );
}
