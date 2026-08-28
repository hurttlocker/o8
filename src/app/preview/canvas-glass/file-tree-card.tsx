'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ChevronRight, FileText, Folder, FolderOpen } from '@/components/desktop/lucide-shims';
import { GlassCardShell } from './card-shell';
import { listCanvasDirectory, resolveCanvasFilePath, type CanvasFileEntry } from './canvas-files';
import type { SnapGeometry } from './canvas-persistence';
import { useCanvasRenderProbe } from './perf/render-probe';
import { CHROME, FONT, scrollFadeY } from './ui';
import { useScrollBlurFade } from './use-scroll-blur-fade';

export interface FileTreeCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  repoPath: string;
}

export const FILE_TREE_MIN_W = 300;
export const FILE_TREE_MIN_H = 220;

interface TreeRowsProps {
  directory: string;
  depth: number;
  entriesByDirectory: Record<string, CanvasFileEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  failed: Set<string>;
  onToggleDirectory: (entry: CanvasFileEntry) => void;
  onOpenFile: (entry: CanvasFileEntry) => void;
}

function TreeRows({
  directory,
  depth,
  entriesByDirectory,
  expanded,
  loading,
  failed,
  onToggleDirectory,
  onOpenFile,
}: TreeRowsProps) {
  return (entriesByDirectory[directory] ?? []).map((entry) => {
    const isDirectory = entry.kind === 'directory';
    const open = isDirectory && expanded.has(entry.path);
    const Icon = open ? FolderOpen : isDirectory ? Folder : FileText;
    return (
      <div key={entry.path}>
        <button
          type="button"
          aria-expanded={isDirectory ? open : undefined}
          data-file-tree-kind={entry.kind}
          data-file-tree-path={entry.path}
          data-file-tree-ignored={entry.ignored ? 'true' : undefined}
          onClick={() => (isDirectory ? onToggleDirectory(entry) : onOpenFile(entry))}
          style={{
            width: '100%',
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            paddingTop: 0,
            paddingRight: 10,
            paddingBottom: 0,
            paddingLeft: 10 + depth * 18,
            borderWidth: 0,
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--cnv-ink)',
            cursor: 'pointer',
            fontFamily: FONT,
            fontSize: CHROME.bodySize,
            fontWeight: CHROME.metaWeight,
            textAlign: 'left',
            opacity: entry.ignored ? 0.55 : 1,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          <span aria-hidden style={{ width: CHROME.iconSize, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {isDirectory ? (
              <ChevronRight
                size={CHROME.iconSize}
                strokeWidth={1.7}
                style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)' }}
              />
            ) : null}
          </span>
          <Icon size={CHROME.iconSize} strokeWidth={1.55} aria-hidden style={{ flexShrink: 0, color: 'var(--cnv-ink-muted)' }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
        </button>
        {open ? (
          loading.has(entry.path) ? (
            <div style={{ paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 52 + depth * 18, color: 'var(--cnv-ink-muted)', fontFamily: FONT, fontSize: CHROME.captionSize }}>
              Loading directory…
            </div>
          ) : failed.has(entry.path) ? (
            <div role="alert" style={{ paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 52 + depth * 18, color: 'var(--t-danger)', fontFamily: FONT, fontSize: CHROME.captionSize }}>
              Unable to load this directory.
            </div>
          ) : (
            <TreeRows
              directory={entry.path}
              depth={depth + 1}
              entriesByDirectory={entriesByDirectory}
              expanded={expanded}
              loading={loading}
              failed={failed}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
            />
          )
        ) : null}
      </div>
    );
  });
}

export const FileTreeGlassCard = memo(function FileTreeGlassCard({
  card,
  spawnFileCard,
  onMove,
  onResize,
  onFocus,
  onClose,
  fetchImpl,
}: {
  card: FileTreeCard;
  spawnFileCard: (path: string, at?: SnapGeometry) => void;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  fetchImpl?: typeof fetch;
}) {
  useCanvasRenderProbe('tree', card.id);
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, CanvasFileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set(['']));
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useScrollBlurFade(scrollRef);

  useEffect(() => {
    let cancelled = false;
    void listCanvasDirectory(card.repoPath, '', fetchImpl ?? fetch)
      .then((entries) => {
        if (!cancelled) setEntriesByDirectory({ '': entries });
      })
      .catch(() => {
        if (!cancelled) setFailed(new Set(['']));
      })
      .finally(() => {
        if (!cancelled) setLoading(new Set());
      });
    return () => { cancelled = true; };
  }, [card.repoPath, fetchImpl]);

  const toggleDirectory = useCallback((entry: CanvasFileEntry) => {
    if (expanded.has(entry.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(entry.path));
    if (entriesByDirectory[entry.path]) return;
    setLoading((current) => new Set(current).add(entry.path));
    setFailed((current) => {
      const next = new Set(current);
      next.delete(entry.path);
      return next;
    });
    void listCanvasDirectory(card.repoPath, entry.path, fetchImpl ?? fetch)
      .then((entries) => setEntriesByDirectory((current) => ({ ...current, [entry.path]: entries })))
      .catch(() => setFailed((current) => new Set(current).add(entry.path)))
      .finally(() => setLoading((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      }));
  }, [card.repoPath, entriesByDirectory, expanded, fetchImpl]);

  const openFile = useCallback((entry: CanvasFileEntry) => {
    spawnFileCard(resolveCanvasFilePath(card.repoPath, entry.path), {
      x: card.x + card.w + 28,
      y: card.y,
      w: 620,
      h: 420,
    });
  }, [card.repoPath, card.w, card.x, card.y, spawnFileCard]);

  const repoName = card.repoPath.split('/').filter(Boolean).pop() ?? card.repoPath;
  const rootLoading = loading.has('');
  const rootFailed = failed.has('');

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={FILE_TREE_MIN_W}
      minH={FILE_TREE_MIN_H}
      title="File tree"
      badge={repoName}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
      <div style={{ height: card.h, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          ref={scrollRef}
          style={{
            ...scrollFadeY,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingTop: 5,
            paddingRight: 8,
            paddingBottom: 12,
            paddingLeft: 8,
            scrollbarWidth: 'none',
          }}
        >
          {rootLoading ? (
            <div style={{ paddingTop: 16, paddingRight: 12, paddingBottom: 16, paddingLeft: 12, color: 'var(--cnv-ink-muted)', fontFamily: FONT, fontSize: CHROME.bodySize }}>
              Loading repository files…
            </div>
          ) : rootFailed ? (
            <div role="alert" style={{ paddingTop: 16, paddingRight: 12, paddingBottom: 16, paddingLeft: 12, color: 'var(--t-danger)', fontFamily: FONT, fontSize: CHROME.bodySize }}>
              Unable to load repository files.
            </div>
          ) : (
            <TreeRows
              directory=""
              depth={0}
              entriesByDirectory={entriesByDirectory}
              expanded={expanded}
              loading={loading}
              failed={failed}
              onToggleDirectory={toggleDirectory}
              onOpenFile={openFile}
            />
          )}
        </div>
      </div>
    </GlassCardShell>
  );
});

export const FileTreeCardLayer = memo(function FileTreeCardLayer({
  cards,
  spawnFileCard,
  onMove,
  onResize,
  onFocus,
  onClose,
}: {
  cards: FileTreeCard[];
  spawnFileCard: (path: string, at?: SnapGeometry) => void;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}) {
  return (
    <AnimatePresence>
      {cards.map((card) => (
        <FileTreeGlassCard
          key={card.id}
          card={card}
          spawnFileCard={spawnFileCard}
          onMove={onMove}
          onResize={onResize}
          onFocus={onFocus}
          onClose={onClose}
        />
      ))}
    </AnimatePresence>
  );
});
