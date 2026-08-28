'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { FileCode2, FileText } from '@/components/desktop/lucide-shims';
import { CHROME, FONT, glassPop, relAge, type CanvasThreadRow } from './ui';

export type CanvasSearchCardKind = 'term' | 'file' | 'image' | 'browser' | 'chat' | 'diff' | 'spec' | 'brain';

export type CanvasSearchHit =
  | { kind: 'card'; cardKind: CanvasSearchCardKind; id: number; title: string; meta: string }
  | { kind: 'thread'; threadId: string; repoPath: string | null; repoName: string | null; title: string; meta: string }
  | { kind: 'repository'; resultKind: 'file' | 'symbol'; path: string; line?: number; title: string; meta: string };

export interface CanvasSearchSources {
  termCards: ReadonlyArray<{ id: number; cwdLabel?: string | null; sessionName?: string | null }>;
  fileCards: ReadonlyArray<{ id: number; name: string; path: string }>;
  imageCards: ReadonlyArray<{ id: number; items: ReadonlyArray<{ name: string }> }>;
  browserCards: ReadonlyArray<{ id: number; tabs: ReadonlyArray<{ url: string }> }>;
  chatCards: ReadonlyArray<{ id: number; threadId: string; title: string; repoName?: string | null }>;
  diffCards: ReadonlyArray<{ id: number; title: string; branch?: string | null }>;
  specCards: ReadonlyArray<{ id: number; repoPath?: string | null }>;
  brainCards: ReadonlyArray<{ id: number; repoPath?: string | null }>;
  recentThreads: ReadonlyArray<CanvasThreadRow>;
}

interface UniversalSearchResult {
  kind?: unknown;
  title?: unknown;
  detail?: unknown;
  target?: {
    filePath?: unknown;
    line?: unknown;
  };
}

interface CanvasSearchOverlayProps extends CanvasSearchSources {
  query: string;
  activeRepoPath: string | null;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onFocusCard: (kind: CanvasSearchCardKind, id: number) => void;
  onPickThread: (
    threadId: string,
    repoPath: string | null,
    hint: { title: string; repoName: string | null },
  ) => void | Promise<unknown>;
  spawnFileCard: (path: string) => void;
  fetchImpl?: typeof fetch;
}

const REPOSITORY_SEARCH_DEBOUNCE_MS = 280;
const MAX_LOCAL_ROWS = 12;
const MAX_REPOSITORY_ROWS = 12;

function resolveRepositoryPath(repoPath: string, filePath: string): string {
  if (filePath.startsWith('/')) return filePath;
  const root = repoPath.replace(/\/+$/, '');
  const relativePath = filePath.replace(/^\.\//, '');
  return `${root}/${relativePath}`;
}

export function buildLocalCanvasSearchHits(query: string, sources: CanvasSearchSources): CanvasSearchHit[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];
  const matches = (value: string | null | undefined) => (value ?? '').toLowerCase().includes(normalizedQuery);
  const hits: CanvasSearchHit[] = [];

  sources.termCards.forEach((card) => {
    if (matches(card.cwdLabel) || matches(card.sessionName)) {
      hits.push({ kind: 'card', cardKind: 'term', id: card.id, title: card.cwdLabel ?? 'Terminal', meta: 'terminal · on the canvas' });
    }
  });
  sources.fileCards.forEach((card) => {
    if (matches(card.name) || matches(card.path)) {
      hits.push({ kind: 'card', cardKind: 'file', id: card.id, title: card.name, meta: 'file · on the canvas' });
    }
  });
  sources.imageCards.forEach((card) => {
    const item = card.items.find((entry) => matches(entry.name));
    if (item) hits.push({ kind: 'card', cardKind: 'image', id: card.id, title: item.name, meta: 'image · on the canvas' });
  });
  sources.browserCards.forEach((card) => {
    const tab = card.tabs.find((entry) => matches(entry.url));
    if (tab) hits.push({ kind: 'card', cardKind: 'browser', id: card.id, title: tab.url.replace(/^https?:\/\//i, ''), meta: 'browser tab · on the canvas' });
  });
  sources.chatCards.forEach((card) => {
    if (matches(card.title) || matches(card.repoName)) {
      hits.push({ kind: 'card', cardKind: 'chat', id: card.id, title: card.title, meta: `${card.repoName ?? 'chat'} · on the canvas` });
    }
  });
  sources.diffCards.forEach((card) => {
    if (matches(card.title) || matches(card.branch)) {
      hits.push({ kind: 'card', cardKind: 'diff', id: card.id, title: card.title, meta: 'diff · on the canvas' });
    }
  });
  sources.specCards.forEach((card) => {
    const repoTail = card.repoPath?.split('/').pop() ?? null;
    if (matches('o8.md') || matches(repoTail)) {
      hits.push({ kind: 'card', cardKind: 'spec', id: card.id, title: `o8.md${repoTail ? ` — ${repoTail}` : ''}`, meta: 'notes · on the canvas' });
    }
  });
  sources.brainCards.forEach((card) => {
    const repoTail = card.repoPath?.split('/').pop() ?? null;
    if (matches('brain') || matches(repoTail)) {
      hits.push({ kind: 'card', cardKind: 'brain', id: card.id, title: `Brain${repoTail ? ` — ${repoTail}` : ''}`, meta: 'engineering brain · on the canvas' });
    }
  });

  const openThreadIds = new Set(sources.chatCards.map((card) => card.threadId));
  let threadHits = 0;
  for (const thread of sources.recentThreads) {
    if (threadHits >= 8) break;
    if (openThreadIds.has(thread.id)) continue;
    if (!matches(thread.title) && !matches(thread.repoName)) continue;
    threadHits += 1;
    hits.push({
      kind: 'thread',
      threadId: thread.id,
      repoPath: thread.repoPath,
      repoName: thread.repoName,
      title: thread.title?.trim() || 'Untitled session',
      meta: [thread.repoName, relAge(thread.lastMessageAt)].filter(Boolean).join(' · ') || 'past session',
    });
  }

  return hits;
}

export function buildRepositoryCanvasSearchHits(
  results: readonly UniversalSearchResult[],
  activeRepoPath: string,
): CanvasSearchHit[] {
  return results.flatMap((result) => {
    if (result.kind !== 'file' && result.kind !== 'symbol') return [];
    const filePath = result.target?.filePath;
    if (typeof filePath !== 'string' || !filePath.trim()) return [];
    const line = typeof result.target?.line === 'number' ? result.target.line : undefined;
    return [{
      kind: 'repository' as const,
      resultKind: result.kind,
      path: resolveRepositoryPath(activeRepoPath, filePath.trim()),
      ...(line ? { line } : {}),
      title: typeof result.title === 'string' && result.title.trim() ? result.title : filePath.split('/').pop() || filePath,
      meta: typeof result.detail === 'string' && result.detail.trim() ? result.detail : filePath,
    }];
  });
}

function searchHitKey(hit: CanvasSearchHit): string {
  if (hit.kind === 'card') return `card:${hit.cardKind}:${hit.id}`;
  if (hit.kind === 'thread') return `thread:${hit.threadId}`;
  return `repository:${hit.resultKind}:${hit.path}:${hit.line ?? ''}:${hit.title}`;
}

export function CanvasSearchOverlay({
  query,
  activeRepoPath,
  onQueryChange,
  onClose,
  onFocusCard,
  onPickThread,
  spawnFileCard,
  fetchImpl,
  termCards,
  fileCards,
  imageCards,
  browserCards,
  chatCards,
  diffCards,
  specCards,
  brainCards,
  recentThreads,
}: CanvasSearchOverlayProps) {
  const normalizedQuery = query.trim();
  const repositorySearchKey = activeRepoPath && normalizedQuery.length >= 2
    ? JSON.stringify([activeRepoPath, normalizedQuery])
    : null;
  const localHits = useMemo(() => buildLocalCanvasSearchHits(query, {
    termCards,
    fileCards,
    imageCards,
    browserCards,
    chatCards,
    diffCards,
    specCards,
    brainCards,
    recentThreads,
  }), [brainCards, browserCards, chatCards, diffCards, fileCards, imageCards, query, recentThreads, specCards, termCards]);
  const [repositoryResult, setRepositoryResult] = useState<{ key: string; hits: CanvasSearchHit[] } | null>(null);
  const repositoryHits = repositoryResult?.key === repositorySearchKey ? repositoryResult.hits : [];

  useEffect(() => {
    if (!repositorySearchKey || !activeRepoPath) return;

    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!cancelled) setRepositoryResult({ key: repositorySearchKey, hits: [] });
      const params = new URLSearchParams({
        q: normalizedQuery,
        workspace: activeRepoPath,
        repo: activeRepoPath,
        categories: 'file,symbol',
      });
      try {
        const response = await (fetchImpl ?? fetch)(`/api/panel/universal-search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = await response.json() as { results?: UniversalSearchResult[] };
        if (!cancelled) {
          setRepositoryResult({
            key: repositorySearchKey,
            hits: buildRepositoryCanvasSearchHits(payload.results ?? [], activeRepoPath),
          });
        }
      } catch {
        // Repository search is additive. Local canvas hits remain usable offline.
      }
    }, REPOSITORY_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeRepoPath, fetchImpl, normalizedQuery, repositorySearchKey]);

  const visibleLocalHits = localHits.slice(0, MAX_LOCAL_ROWS);
  const visibleRepositoryHits = repositoryHits.slice(0, MAX_REPOSITORY_ROWS);
  const firstHit = localHits[0] ?? repositoryHits[0];

  const activate = (hit: CanvasSearchHit) => {
    if (hit.kind === 'card') onFocusCard(hit.cardKind, hit.id);
    else if (hit.kind === 'thread') void onPickThread(hit.threadId, hit.repoPath, { title: hit.title, repoName: hit.repoName });
    else spawnFileCard(hit.path);
    onClose();
    onQueryChange('');
  };

  const renderRow = (hit: CanvasSearchHit) => {
    const RepositoryIcon = hit.kind === 'repository'
      ? (hit.resultKind === 'symbol' ? FileCode2 : FileText)
      : null;
    return (
      <button
        key={searchHitKey(hit)}
        type="button"
        data-search-hit-kind={hit.kind}
        data-search-hit-title={hit.title}
        onClick={() => activate(hit)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        {RepositoryIcon ? (
          <RepositoryIcon size={CHROME.iconSize} strokeWidth={1.7} aria-hidden style={{ flexShrink: 0, color: 'var(--cnv-ink-muted)' }} />
        ) : null}
        <span style={{ display: 'flex', flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
          <span style={{ fontSize: CHROME.bodySize, fontWeight: CHROME.metaWeight, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
            {hit.title}
          </span>
          <span style={{ fontSize: CHROME.captionSize, fontWeight: CHROME.metaWeight, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
            {hit.meta}
          </span>
        </span>
      </button>
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      style={{
        position: 'absolute',
        top: 64,
        right: 24,
        width: 300,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 16,
        zIndex: 41,
        overflow: 'hidden',
        ...glassPop(),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, paddingLeft: 12, paddingRight: 12 }}>
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && firstHit) activate(firstHit);
            if (event.key === 'Escape') onClose();
          }}
          placeholder="Cards, past sessions, and repository"
          aria-label="Search the canvas"
          style={{
            flex: 1,
            borderWidth: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--cnv-ink)',
            fontSize: CHROME.bodySize,
            fontWeight: CHROME.metaWeight,
            letterSpacing: '-0.1px',
            fontFamily: FONT,
          }}
        />
      </div>
      {query.trim() ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 6, paddingBottom: 8, paddingLeft: 6, paddingRight: 6, borderTop: '1px solid var(--cnv-edge)', maxHeight: 300, overflowY: 'auto', scrollbarWidth: 'none' }}>
          {visibleLocalHits.length === 0 && visibleRepositoryHits.length === 0 ? (
            <span style={{ fontSize: CHROME.captionSize, fontWeight: CHROME.metaWeight, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingTop: 4, paddingBottom: 4, paddingLeft: 8 }}>
              No matches on the canvas or in this repository.
            </span>
          ) : (
            <>
              {visibleLocalHits.map(renderRow)}
              {visibleRepositoryHits.length > 0 ? (
                <>
                  <span data-search-group="repository" style={{ fontSize: CHROME.captionSize, fontWeight: CHROME.titleWeight, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingTop: visibleLocalHits.length > 0 ? 8 : 3, paddingBottom: 2, paddingLeft: 8, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    Repository
                  </span>
                  {visibleRepositoryHits.map(renderRow)}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}
