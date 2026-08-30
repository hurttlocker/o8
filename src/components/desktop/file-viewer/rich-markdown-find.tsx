'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

interface RichMarkdownFindMatch {
  from: number;
  to: number;
}

interface RichMarkdownFindState {
  query: string;
  matches: readonly RichMarkdownFindMatch[];
  activeIndex: number;
  decorations: DecorationSet;
}

interface RichMarkdownFindMeta {
  query?: string;
  activeIndex?: number;
}

interface RichMarkdownFindListener {
  onOpen: () => void;
  onState: (state: RichMarkdownFindState) => void;
}

const emptyFindState: RichMarkdownFindState = {
  query: '',
  matches: [],
  activeIndex: -1,
  decorations: DecorationSet.empty,
};

const findPluginKey = new PluginKey<RichMarkdownFindState>('rich-markdown-find');
const findListeners = new WeakMap<EditorView, Set<RichMarkdownFindListener>>();

function findTextMatches(
  doc: ProseMirrorNode,
  query: string,
): RichMarkdownFindMatch[] {
  if (!query) return [];
  const normalizedQuery = query.toLocaleLowerCase();
  const matches: RichMarkdownFindMatch[] = [];

  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    const characters: string[] = [];
    const positions: number[] = [];

    node.forEach((child, offset) => {
      if (!child.isText || !child.text) {
        characters.push('\u0000');
        positions.push(-1);
        return;
      }
      for (let index = 0; index < child.text.length; index += 1) {
        characters.push(child.text[index]);
        positions.push(position + 1 + offset + index);
      }
    });

    const searchable = characters.join('').toLocaleLowerCase();
    let searchFrom = 0;
    while (searchFrom <= searchable.length - normalizedQuery.length) {
      const matchOffset = searchable.indexOf(normalizedQuery, searchFrom);
      if (matchOffset === -1) break;
      const from = positions[matchOffset];
      const lastPosition = positions[matchOffset + query.length - 1];
      if (from >= 0 && lastPosition >= from) {
        matches.push({ from, to: lastPosition + 1 });
      }
      searchFrom = matchOffset + Math.max(query.length, 1);
    }
    return false;
  });

  return matches;
}

function buildDecorations(
  doc: ProseMirrorNode,
  matches: readonly RichMarkdownFindMatch[],
  activeIndex: number,
): DecorationSet {
  return DecorationSet.create(doc, matches.map((match, index) => {
    const active = index === activeIndex;
    return Decoration.inline(match.from, match.to, {
      'data-rich-find-active': active ? 'true' : 'false',
      'data-rich-find-match': 'true',
      style: active
        ? 'background:var(--t-accent-soft-strong);border-radius:2px;box-shadow:0 0 0 1px var(--t-accent-border)'
        : 'background:var(--t-warning-soft);border-radius:2px',
    });
  }));
}

function normalizeActiveIndex(index: number, matchCount: number): number {
  if (matchCount === 0) return -1;
  return ((index % matchCount) + matchCount) % matchCount;
}

function publishFindState(view: EditorView): void {
  const state = findPluginKey.getState(view.state) ?? emptyFindState;
  findListeners.get(view)?.forEach((listener) => listener.onState(state));
}

function publishFindOpen(view: EditorView): void {
  findListeners.get(view)?.forEach((listener) => listener.onOpen());
}

export const richMarkdownFindPlugin = new Plugin<RichMarkdownFindState>({
  key: findPluginKey,
  state: {
    init: () => emptyFindState,
    apply: (transaction, previous) => {
      const meta = transaction.getMeta(findPluginKey) as RichMarkdownFindMeta | undefined;
      const query = meta?.query ?? previous.query;
      if (!transaction.docChanged && !meta) return previous;
      const matches = transaction.docChanged || query !== previous.query
        ? findTextMatches(transaction.doc, query)
        : previous.matches;
      const requestedIndex = meta?.activeIndex
        ?? (query === previous.query ? previous.activeIndex : 0);
      const activeIndex = normalizeActiveIndex(requestedIndex, matches.length);
      return {
        query,
        matches,
        activeIndex,
        decorations: buildDecorations(transaction.doc, matches, activeIndex),
      };
    },
  },
  props: {
    decorations: (state) => findPluginKey.getState(state)?.decorations ?? null,
    handleKeyDown: (view, event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return false;
      event.preventDefault();
      publishFindOpen(view);
      return true;
    },
  },
  view: (view) => ({
    update: (nextView, previousState) => {
      if (findPluginKey.getState(nextView.state) !== findPluginKey.getState(previousState)) {
        publishFindState(nextView);
      }
    },
    destroy: () => {
      findListeners.delete(view);
    },
  }),
});

function subscribeToFind(
  view: EditorView,
  listener: RichMarkdownFindListener,
): () => void {
  const listeners = findListeners.get(view) ?? new Set<RichMarkdownFindListener>();
  listeners.add(listener);
  findListeners.set(view, listeners);
  listener.onState(findPluginKey.getState(view.state) ?? emptyFindState);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) findListeners.delete(view);
  };
}

function dispatchFind(
  view: EditorView,
  query: string,
  matches: readonly RichMarkdownFindMatch[],
  activeIndex: number,
): void {
  const normalizedIndex = normalizeActiveIndex(activeIndex, matches.length);
  let transaction = view.state.tr.setMeta(findPluginKey, {
    query,
    activeIndex: normalizedIndex,
  } satisfies RichMarkdownFindMeta);
  const match = matches[normalizedIndex];
  if (match) {
    transaction = transaction
      .setSelection(TextSelection.create(transaction.doc, match.from, match.to))
      .scrollIntoView();
  }
  view.dispatch(transaction);
}

function setFindQuery(view: EditorView, query: string): void {
  const matches = findTextMatches(view.state.doc, query);
  const selectionFrom = view.state.selection.from;
  const activeIndex = matches.findIndex((match) => match.from >= selectionFrom);
  dispatchFind(view, query, matches, activeIndex === -1 ? 0 : activeIndex);
}

function moveFindSelection(view: EditorView, delta: number): void {
  const state = findPluginKey.getState(view.state) ?? emptyFindState;
  if (state.matches.length === 0) return;
  dispatchFind(view, state.query, state.matches, state.activeIndex + delta);
}

const findButtonStyle = {
  width: 26,
  height: 26,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 13,
  fontWeight: 300,
  lineHeight: 1,
  cursor: 'pointer',
} as const;

export function RichMarkdownFind({ view }: { view: EditorView | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef('');
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [query, setQuery] = useState('');
  const [findState, setFindState] = useState<RichMarkdownFindState>(emptyFindState);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (!view) return undefined;
    return subscribeToFind(view, {
      onOpen: () => {
        setOpen(true);
        setFocusRequest((current) => current + 1);
        if (queryRef.current) setFindQuery(view, queryRef.current);
      },
      onState: setFindState,
    });
  }, [view]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest, open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    queryRef.current = '';
    if (view) {
      setFindQuery(view, '');
      view.focus();
    }
  }, [view]);

  const move = useCallback((delta: number) => {
    if (view) moveFindSelection(view, delta);
  }, [view]);

  if (!view || !open) return null;

  const matchLabel = findState.matches.length === 0
    ? (query ? 'No results' : '0/0')
    : `${findState.activeIndex + 1}/${findState.matches.length}`;

  return (
    <div
      style={{
        position: 'sticky',
        top: 8,
        zIndex: 20,
        height: 0,
        paddingRight: 8,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        role="search"
        aria-label="Find in rich Markdown"
        style={{
          width: 304,
          minHeight: 34,
          paddingTop: 4,
          paddingRight: 4,
          paddingBottom: 4,
          paddingLeft: 6,
          border: '1px solid var(--t-divider-subtle)',
          borderRadius: 9,
          background: 'var(--t-panel-solid)',
          boxShadow: 'var(--t-panel-shadow)',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <input
          ref={inputRef}
          aria-label="Find query"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            queryRef.current = nextQuery;
            setFindQuery(view, nextQuery);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
              event.preventDefault();
              inputRef.current?.select();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          placeholder="Find"
          style={{
            minWidth: 0,
            flex: 1,
            height: 26,
            paddingTop: 0,
            paddingRight: 7,
            paddingBottom: 0,
            paddingLeft: 7,
            border: '1px solid var(--t-search-border)',
            borderRadius: 7,
            outline: 'none',
            background: 'var(--t-search-bg)',
            color: 'var(--t-text)',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 11,
            fontWeight: 300,
          }}
        />
        <span
          role="status"
          aria-live="polite"
          style={{
            minWidth: 34,
            color: 'var(--t-text-faint)',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 10,
            fontWeight: 300,
            textAlign: 'center',
            whiteSpace: 'nowrap',
          }}
        >
          {matchLabel}
        </span>
        <button
          type="button"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={findState.matches.length === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => move(-1)}
          style={{
            ...findButtonStyle,
            cursor: findState.matches.length === 0 ? 'default' : 'pointer',
            opacity: findState.matches.length === 0 ? 0.45 : 1,
          }}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={findState.matches.length === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => move(1)}
          style={{
            ...findButtonStyle,
            cursor: findState.matches.length === 0 ? 'default' : 'pointer',
            opacity: findState.matches.length === 0 ? 0.45 : 1,
          }}
        >
          ↓
        </button>
        <button
          type="button"
          aria-label="Close find"
          title="Close (Escape)"
          onMouseDown={(event) => event.preventDefault()}
          onClick={close}
          style={findButtonStyle}
        >
          ×
        </button>
      </div>
    </div>
  );
}
