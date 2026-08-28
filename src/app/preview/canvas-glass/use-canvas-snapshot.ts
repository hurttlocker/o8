'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { BrainCard } from './brain-card';
import type { BrowserCard } from './browser-card';
import type { ChatCard } from './chat-card';
import { loadCanvasSnapshot, saveCanvasSnapshot, type SnapGeometry } from './canvas-persistence';
import type { DiffCard } from './diff-card';
import type { FileCard } from './file-card';
import type { FileTreeCard } from './file-tree-card';
import type { ImageCard } from './image-card';
import type { MarkdownCard } from './markdown-card';
import type { SpecCard } from './spec-card';
import type { TermCard } from './terminal-card';
import type { VideoCard } from './video-card';

interface MutableRef<T> {
  current: T;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface UseCanvasSnapshotDeps {
  activeRepoPath: string | null;
  dockOpen: boolean;
  termCards: TermCard[];
  fileCards: FileCard[];
  treeCards: FileTreeCard[];
  imageCards: ImageCard[];
  videoCards: VideoCard[];
  browserCards: BrowserCard[];
  chatCards: ChatCard[];
  diffCards: DiffCard[];
  specCards: SpecCard[];
  markdownCards: MarkdownCard[];
  brainCards: BrainCard[];
  setActiveRepoPath: StateSetter<string | null>;
  setDockOpen: StateSetter<boolean>;
  setBrowserCards: StateSetter<BrowserCard[]>;
  setSpecCards: StateSetter<SpecCard[]>;
  setBrainCards: StateSetter<BrainCard[]>;
  setImageCards: StateSetter<ImageCard[]>;
  setMarkdownCards: StateSetter<MarkdownCard[]>;
  setVideoCards: StateSetter<VideoCard[]>;
  nextIdRef: MutableRef<number>;
  zPeakRef: MutableRef<number>;
  canvasMedia: {
    createObjectURL: (blob: Blob) => string | null;
  };
  getMedia: (id: string) => Promise<Blob | null>;
  checkAliveSessions: (sessionNames: string[]) => Promise<Set<string>>;
  spawnFileCard: (path: string, at?: SnapGeometry, repoOverride?: string) => void;
  spawnFileTreeCard: (repoPath: string, at?: SnapGeometry) => void;
  pickThread: (threadId: string, repoPath: string | null, meta?: { title?: string | null; repoName?: string | null }, at?: SnapGeometry) => Promise<void>;
  spawnDiffCard: (lane: { id: string; label?: string | null }, at?: SnapGeometry) => Promise<void>;
  spawnWorktreeDiffCard: (at?: SnapGeometry, repoOverride?: string) => Promise<void>;
  spawnTerminal: (cwd: string | null, cwdLabel: string | null, at?: SnapGeometry) => void;
  reattachTerminal: (sessionName: string, cwd: string | null, cwdLabel: string | null, at?: SnapGeometry) => void;
}

export function useCanvasSnapshot({
  activeRepoPath,
  dockOpen,
  termCards,
  fileCards,
  treeCards,
  imageCards,
  videoCards,
  browserCards,
  chatCards,
  diffCards,
  specCards,
  markdownCards,
  brainCards,
  setActiveRepoPath,
  setDockOpen,
  setBrowserCards,
  setSpecCards,
  setBrainCards,
  setImageCards,
  setMarkdownCards,
  setVideoCards,
  nextIdRef,
  zPeakRef,
  canvasMedia,
  getMedia,
  checkAliveSessions,
  spawnFileCard,
  spawnFileTreeCard,
  pickThread,
  spawnDiffCard,
  spawnWorktreeDiffCard,
  spawnTerminal,
  reattachTerminal,
}: UseCanvasSnapshotDeps) {
  // ── Canvas persistence — the canvas is a place, not a session. ──────
  // Restore once on mount: pure-state kinds land directly, live kinds go
  // back through their real spawn paths (terminals respawn shells in the
  // saved cwd, chat cards refetch their thread, diff cards refetch the
  // lane and silently drop if it's gone).
  const restoredRef = useRef(false);
  const persistArmedAtRef = useRef(0);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const snap = loadCanvasSnapshot();
    if (!snap) return;
    // Ceiling, not the arm point — the async restores release it early
    // below. A dev-server cold compile can hold a thread fetch past any
    // fixed short window, and a save in that gap loses the unfetched cards.
    persistArmedAtRef.current = Date.now() + 12000;
    if (snap.activeRepoPath) setActiveRepoPath((current) => current ?? snap.activeRepoPath);
    if (snap.dockOpen) setDockOpen(true);

    if (snap.browser.length) {
      setBrowserCards((previous) => [...previous, ...snap.browser.map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, tabs: saved.tabs, activeTabId: saved.activeTabId };
      })]);
    }
    if (snap.spec.length) {
      setSpecCards((previous) => [...previous, ...snap.spec.map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, repoPath: saved.repoPath };
      })]);
    }
    if (snap.brain?.length) {
      setBrainCards((previous) => [...previous, ...(snap.brain ?? []).map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, repoPath: saved.repoPath };
      })]);
    }
    if (snap.image.length) {
      setImageCards((previous) => [...previous, ...snap.image.map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, aspect: saved.aspect, items: saved.items };
      })]);
    }
    if (snap.markdown?.length) {
      setMarkdownCards((previous) => [...previous, ...(snap.markdown ?? []).map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, title: saved.title, markdown: saved.markdown };
      })]);
    }
    snap.file.forEach((saved) => spawnFileCard(saved.path, saved, saved.repoPath ?? snap.activeRepoPath ?? undefined));
    snap.tree?.forEach((saved) => spawnFileTreeCard(saved.repoPath, saved));
    const videoRestores = (snap.video ?? []).map(async (saved) => {
      const blob = await getMedia(saved.mediaId);
      if (!blob) return;
      const src = canvasMedia.createObjectURL(blob);
      if (!src) return;
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      setVideoCards((previous) => [...previous, { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, aspect: saved.aspect, src, name: saved.name, mediaId: saved.mediaId }]);
    });
    const settles: Array<Promise<unknown>> = [
      ...videoRestores,
      ...snap.chat.map((saved) => pickThread(saved.threadId, saved.repoPath, { title: saved.title, repoName: saved.repoName }, saved)),
      ...snap.diff.map((saved) => (saved.laneId.startsWith('worktree:')
        ? spawnWorktreeDiffCard(saved, saved.laneId.slice('worktree:'.length)) ?? Promise.resolve()
        : spawnDiffCard({ id: saved.laneId, label: saved.title }, saved))),
    ];
    if (snap.term.length) {
      // The terminal ws needs a beat to connect before create requests land.
      // #6 persistent terminals — re-attach saved shells whose tmux session
      // survived (checkAliveSessions unions live tmux sessions under the flag);
      // respawn the rest fresh, exactly as before.
      setTimeout(() => {
        void (async () => {
          const names = snap.term.map((saved) => saved.sessionName).filter((name): name is string => Boolean(name));
          const alive = names.length ? await checkAliveSessions(names) : new Set<string>();
          snap.term.forEach((saved) => {
            if (saved.sessionName && alive.has(saved.sessionName)) {
              reattachTerminal(saved.sessionName, saved.cwd, saved.cwdLabel, saved);
            } else {
              spawnTerminal(saved.cwd, saved.cwdLabel, saved);
            }
          });
        })();
      }, 1200);
    }
    void Promise.allSettled(settles).then(() => {
      // Every fetch-backed card has landed (or dropped) — release the save
      // guard, padded past the terminal respawn timer.
      persistArmedAtRef.current = Math.min(persistArmedAtRef.current, Date.now() + 2000);
    });
  }, [canvasMedia, pickThread, spawnDiffCard, spawnFileCard, spawnFileTreeCard, spawnTerminal, reattachTerminal, spawnWorktreeDiffCard]);

  // Build the snapshot only when the debounce fires. Dragging used to stringify
  // every card on every pointer move even though localStorage writes were delayed.
  const buildCanvasSnapshot = useCallback(() => ({
    v: 1 as const,
    activeRepoPath,
    dockOpen,
    term: termCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, cwd: card.cwd, cwdLabel: card.cwdLabel, sessionName: card.sessionName })),
    file: fileCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, path: card.path, repoPath: card.repoPath })),
    tree: treeCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, repoPath: card.repoPath })),
    image: imageCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, aspect: card.aspect, items: card.items })),
    video: videoCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, aspect: card.aspect, mediaId: card.mediaId, name: card.name })),
    browser: browserCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, tabs: card.tabs, activeTabId: card.activeTabId })),
    chat: chatCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, threadId: card.threadId, repoPath: card.repoPath, repoName: card.repoName, title: card.title })),
    diff: diffCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, laneId: card.laneId, title: card.title })),
    spec: specCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, repoPath: card.repoPath })),
    markdown: markdownCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, title: card.title, markdown: card.markdown })),
    brain: brainCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, repoPath: card.repoPath })),
  }), [activeRepoPath, dockOpen, termCards, fileCards, treeCards, imageCards, videoCards, browserCards, chatCards, diffCards, specCards, markdownCards, brainCards]);
  const flushCanvasSnapshot = useCallback((force = false) => {
    if (!restoredRef.current || (!force && Date.now() < persistArmedAtRef.current)) return;
    saveCanvasSnapshot(buildCanvasSnapshot());
  }, [buildCanvasSnapshot]);

  useEffect(() => {
    const target = window as unknown as Record<string, unknown>;
    const forceFlush = () => flushCanvasSnapshot(true);
    target.__o8CanvasFlushSnapshot = forceFlush;
    window.addEventListener('beforeunload', forceFlush);
    return () => {
      if (target.__o8CanvasFlushSnapshot === forceFlush) delete target.__o8CanvasFlushSnapshot;
      window.removeEventListener('beforeunload', forceFlush);
    };
  }, [flushCanvasSnapshot]);

  useEffect(() => {
    // Hold fire until restore's async spawns settle — an instant save of
    // the half-restored canvas would overwrite the snapshot.
    if (!restoredRef.current || Date.now() < persistArmedAtRef.current) return;
    const timer = setTimeout(flushCanvasSnapshot, 700);
    return () => clearTimeout(timer);
  }, [flushCanvasSnapshot]);
}
