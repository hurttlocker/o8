'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  IconActivity,
  IconChat,
  IconClose,
  IconOrchestrator,
  IconSearch,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  mobileFontFamily,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import { mobileSafeBottom } from '@/app/mobile/mobile-shell-primitives';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import type {
  MobileSearchCategory,
  MobileSearchResponse,
  MobileSearchResult,
} from '@/app/api/mobile/search/route';

const DEBOUNCE_MS = 200;
const RECENT_STORAGE_KEY = 'o8:mobile:recent';
const RECENT_LIMIT = 5;
const VISIBLE_PER_GROUP_DEFAULT = 5;

export interface MobileSearchRecentEntry {
  category: MobileSearchCategory;
  id: string;
  title: string;
  preview?: string;
  timestamp: string;
  meta?: Record<string, string>;
}

export interface MobileSearchTarget {
  category: MobileSearchCategory;
  id: string;
  title: string;
  meta?: Record<string, string>;
}

interface MobileSearchSheetProps {
  open: boolean;
  onClose: () => void;
  onResultSelect: (target: MobileSearchTarget) => void;
  palette: MobilePalette;
}

function getWsToken(): string {
  return getMobileWsToken();
}

function readRecentEntries(): MobileSearchRecentEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MobileSearchRecentEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.title === 'string').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Hook: registers a window-level "/" keydown listener that opens search.
 * Skipped while the user is typing in an input/textarea/contentEditable so
 * we don't hijack composer keystrokes.
 */
export function useMobileSearchHotkey(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}

export function pushRecentEntry(entry: MobileSearchRecentEntry) {
  if (typeof window === 'undefined') return;
  try {
    const current = readRecentEntries();
    const deduped = current.filter((existing) => !(existing.category === entry.category && existing.id === entry.id));
    const next = [entry, ...deduped].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

function CategoryIcon({ category, palette }: { category: MobileSearchCategory; palette: MobilePalette }) {
  if (category === 'chat') return <IconChat fill={palette.iconFill} size={18} />;
  if (category === 'thread') return <IconOrchestrator fill={palette.iconFill} size={18} />;
  return <IconActivity fill={palette.iconFill} size={18} />;
}

function categoryLabel(category: MobileSearchCategory): string {
  if (category === 'chat') return 'Chats';
  if (category === 'thread') return 'Threads';
  return 'Activity';
}

function ResultRow({
  result,
  palette,
  onClick,
}: {
  result: MobileSearchResult | MobileSearchRecentEntry;
  palette: MobilePalette;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 12px',
        background: 'transparent',
        border: 'none',
        borderRadius: MOBILE_CARD_RADIUS,
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        color: palette.rootText,
        width: '100%',
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          minWidth: 32,
          minHeight: 32,
          borderRadius: 999,
          background: palette.panelElevated,
          border: `1px solid ${palette.cardBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        <CategoryIcon category={result.category} palette={palette} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: MOBILE_BODY_TRACKING,
            color: palette.rootText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {result.title}
        </div>
        {result.preview ? (
          <div
            style={{
              fontSize: 12,
              marginTop: 2,
              color: palette.subduedText,
              letterSpacing: MOBILE_BODY_TRACKING,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {result.preview}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function GroupHeader({
  label,
  count,
  palette,
}: {
  label: string;
  count: number;
  palette: MobilePalette;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 12px 6px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: palette.subduedText,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: palette.subduedText,
          letterSpacing: MOBILE_BODY_TRACKING,
        }}
      >
        {count}
      </div>
    </div>
  );
}

export function MobileSearchSheet({
  open,
  onClose,
  onResultSelect,
  palette,
}: MobileSearchSheetProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [response, setResponse] = useState<MobileSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<MobileSearchCategory, boolean>>({
    chat: false,
    thread: false,
    activity: false,
  });
  const [recent, setRecent] = useState<MobileSearchRecentEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state every time the sheet opens. Always autofocus the input so the
  // keyboard pops up immediately on iOS — matches Spotlight expectations.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDebouncedQuery('');
    setResponse(null);
    setError(null);
    setExpanded({ chat: false, thread: false, activity: false });
    setRecent(readRecentEntries());
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Debounce input → debouncedQuery
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Fetch on debounced query change
  useEffect(() => {
    if (!open) return;
    if (!debouncedQuery) {
      setResponse(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const headers: Record<string, string> = {};
    const token = getWsToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    void fetch(`/api/mobile/search?q=${encodeURIComponent(debouncedQuery)}`, {
      cache: 'no-store',
      headers,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MobileSearchResponse;
        if (!cancelled) {
          setResponse(data);
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        console.log('[mobile-search] fetch failed', reason);
        setError('Unable to run search');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, open]);

  const handleSelect = useCallback(
    (result: MobileSearchResult | MobileSearchRecentEntry) => {
      pushRecentEntry({
        category: result.category,
        id: result.id,
        title: result.title,
        preview: 'preview' in result ? result.preview : undefined,
        timestamp: result.timestamp,
        meta: result.meta,
      });
      onResultSelect({
        category: result.category,
        id: result.id,
        title: result.title,
        meta: result.meta,
      });
      onClose();
    },
    [onClose, onResultSelect],
  );

  const groups = useMemo(() => {
    if (!response) return null;
    return [
      { category: 'chat' as const, label: 'Chats', items: response.groups.chats, truncated: response.truncated.chats },
      { category: 'thread' as const, label: 'Threads', items: response.groups.threads, truncated: response.truncated.threads },
      { category: 'activity' as const, label: 'Activity', items: response.groups.activity, truncated: response.truncated.activity },
    ];
  }, [response]);

  const totalHits = useMemo(() => {
    if (!response) return 0;
    return response.groups.chats.length + response.groups.threads.length + response.groups.activity.length;
  }, [response]);

  if (!open) {
    return (
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0,
        }}
      />
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Search"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: palette.rootBackground,
        color: palette.rootText,
        fontFamily: mobileFontFamily(),
        letterSpacing: MOBILE_BODY_TRACKING,
        display: 'flex',
        flexDirection: 'column',
        animation: 'mobileSearchSheetIn 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
      } as CSSProperties}
    >
      <style>{`
        @keyframes mobileSearchSheetIn {
          from { transform: translateY(24px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

      {/* Header — sticky, holds the input + close */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          background: palette.rootBackground,
          borderBottom: `1px solid ${palette.cardBorder}`,
          paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)',
          paddingLeft: 12,
          paddingRight: 12,
          paddingBottom: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 12px',
              height: MOBILE_TOUCH_TARGET,
              borderRadius: MOBILE_CARD_RADIUS,
              background: palette.inputBackground,
              border: `1px solid ${palette.inputBorder}`,
            }}
          >
            <IconSearch fill={palette.iconFill} size={18} />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats, threads, activity"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: palette.rootText,
                fontSize: 16,
                letterSpacing: MOBILE_BODY_TRACKING,
                fontFamily: 'inherit',
              }}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            style={{
              width: MOBILE_TOUCH_TARGET,
              height: MOBILE_TOUCH_TARGET,
              minWidth: MOBILE_TOUCH_TARGET,
              minHeight: MOBILE_TOUCH_TARGET,
              borderRadius: 999,
              background: 'transparent',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: palette.rootText,
              WebkitTapHighlightColor: 'transparent',
              flexShrink: 0,
            }}
          >
            <IconClose fill={palette.iconFill} size={20} />
          </button>
        </div>
      </div>

      {/* Body — scroll container */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          paddingLeft: 4,
          paddingRight: 4,
          paddingBottom: mobileSafeBottom(24),
        } as CSSProperties}
      >
        {!debouncedQuery ? (
          recent.length > 0 ? (
            <div>
              <GroupHeader label="Recent" count={recent.length} palette={palette} />
              <div style={{ padding: '0 4px' }}>
                {recent.map((entry) => (
                  <ResultRow
                    key={`${entry.category}:${entry.id}`}
                    result={entry}
                    palette={palette}
                    onClick={() => handleSelect(entry)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div
              style={{
                marginTop: 64,
                padding: '0 24px',
                textAlign: 'center',
                color: palette.subduedText,
                fontSize: 14,
                letterSpacing: MOBILE_BODY_TRACKING,
              }}
            >
              Search across chats, orchestrator threads, and activity events.
            </div>
          )
        ) : null}

        {debouncedQuery && loading && !response ? (
          <div
            style={{
              marginTop: 48,
              textAlign: 'center',
              color: palette.subduedText,
              fontSize: 13,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            Searching...
          </div>
        ) : null}

        {debouncedQuery && error ? (
          <div
            style={{
              margin: 16,
              padding: '12px 14px',
              borderRadius: MOBILE_CARD_RADIUS,
              border: `1px solid ${palette.dangerBorder}`,
              background: palette.dangerSoft,
              fontSize: 13,
              color: palette.rootText,
            }}
          >
            {error}
          </div>
        ) : null}

        {debouncedQuery && response && totalHits === 0 && !loading ? (
          <div
            style={{
              marginTop: 48,
              textAlign: 'center',
              color: palette.subduedText,
              fontSize: 14,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            No results for &ldquo;{response.query}&rdquo;
          </div>
        ) : null}

        {debouncedQuery && groups
          ? groups.map(({ category, label, items, truncated }) => {
              if (items.length === 0) return null;
              const isExpanded = expanded[category];
              const visible = isExpanded ? items : items.slice(0, VISIBLE_PER_GROUP_DEFAULT);
              const hiddenCount = items.length - visible.length;
              return (
                <div key={category}>
                  <GroupHeader label={label} count={items.length} palette={palette} />
                  <div style={{ padding: '0 4px' }}>
                    {visible.map((item) => (
                      <ResultRow
                        key={`${category}:${item.id}`}
                        result={item}
                        palette={palette}
                        onClick={() => handleSelect(item)}
                      />
                    ))}
                  </div>
                  {hiddenCount > 0 || truncated ? (
                    <button
                      type="button"
                      onClick={() => setExpanded((current) => ({ ...current, [category]: true }))}
                      style={{
                        margin: '6px 12px 4px',
                        padding: '8px 12px',
                        background: 'transparent',
                        border: `1px solid ${palette.cardBorder}`,
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: MOBILE_HEADING_TRACKING,
                        color: palette.subduedText,
                        cursor: 'pointer',
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      Show more {categoryLabel(category).toLowerCase()}
                      {truncated ? ' (top 20)' : ''}
                    </button>
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}
