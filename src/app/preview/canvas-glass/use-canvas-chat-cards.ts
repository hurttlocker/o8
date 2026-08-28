'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { SnapGeometry } from './canvas-persistence';
import { clearCanvasTurnAccumulators, removeCanvasConversations, setCanvasConversation } from './canvas-conversation-retention';
import type { ChatCard } from './chat-card';
import type { TurnTools } from './result-cards';
import type { useCanvasCards } from './use-canvas-cards';
import type { useCanvasOrchestrator } from './use-canvas-orchestrator';
import type { DockEntry, NewDockEntry } from './ui';

interface MutableRef<T> {
  current: T;
}

type CanvasCards = ReturnType<typeof useCanvasCards>;

interface UseCanvasChatCardsDeps extends Pick<CanvasCards, 'chatCards' | 'setChatCards' | 'zPeakRef'> {
  activeRepoPath: string | null;
  convos: Record<string, DockEntry[]>;
  repos: Array<{ name: string; path: string }> | null;
  orch: ReturnType<typeof useCanvasOrchestrator>;
  nextIdRef: MutableRef<number>;
  entryIdRef: MutableRef<number>;
  firstOutputRef: MutableRef<Set<string>>;
  turnTextRef: MutableRef<Map<string, string>>;
  turnToolsRef: MutableRef<Map<string, TurnTools>>;
  setConvos: Dispatch<SetStateAction<Record<string, DockEntry[]>>>;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  setActiveRepoPath: Dispatch<SetStateAction<string | null>>;
  findFreeSpot: (w: number, h: number, anchor?: { x: number; y: number } | null) => { x: number; y: number };
  appendEntries: (lane: string, entries: NewDockEntry[]) => void;
}

export function useCanvasChatCards({
  activeRepoPath,
  convos,
  repos,
  orch,
  nextIdRef,
  entryIdRef,
  firstOutputRef,
  turnTextRef,
  turnToolsRef,
  chatCards,
  setChatCards,
  zPeakRef,
  setConvos,
  setDockOpen,
  setActiveRepoPath,
  findFreeSpot,
  appendEntries,
}: UseCanvasChatCardsDeps) {
  const pickThread = useCallback((threadId: string, repoPath: string | null, meta?: { title?: string | null; repoName?: string | null }, at?: SnapGeometry) => {
    return fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { messages?: Array<{ role?: string; content?: string }>; title?: string | null; repoName?: string | null; repoPath?: string | null } | null) => {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        const entries: DockEntry[] = [];
        for (const message of messages) {
          const text = typeof message.content === 'string' ? message.content.trim() : '';
          if (!text) continue;
          const id = entryIdRef.current;
          entryIdRef.current += 1;
          entries.push(message.role === 'user' ? { role: 'user', text, id } : { role: 'text', text, id });
        }
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const firstUser = messages.find((message) => message.role === 'user');
        const spot = at ?? findFreeSpot(380, 400);
        // The card's live convo lane starts from the history transcript —
        // its in-card composer streams onto the same lane from there.
        setConvos((previous) => setCanvasConversation(previous, `thread:${threadId}`, entries));
        setChatCards((previous) => [...previous, {
          id,
          threadId,
          repoPath: repoPath ?? data?.repoPath ?? null,
          repoName: meta?.repoName ?? data?.repoName ?? null,
          title: meta?.title?.trim() || data?.title?.trim() || (typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 60) : 'Past session'),
          x: spot.x,
          y: spot.y,
          z: zPeakRef.current,
          w: at?.w ?? 380,
          h: at?.h ?? 400,
          entries,
        }]);
      })
      .catch(() => {});
  }, [findFreeSpot, setChatCards, zPeakRef]);

  /** A chat card's own composer went out — append the turn to its lane.
   *  Mirrors sendPrompt's entry shapes; the card already did the ws send. */
  const noteCardSend = useCallback((card: ChatCard, text: string, sent: boolean): number => {
    const lane = `thread:${card.threadId}`;
    firstOutputRef.current.delete(lane);
    const fromEntryId = entryIdRef.current;
    appendEntries(lane, sent
      ? [{ role: 'user', text }, { role: 'status', text: 'Thinking', pending: true }]
      : [{ role: 'user', text }, { role: 'status', text: 'Not connected yet — try again in a second', pending: false }]);
    return fromEntryId;
  }, [appendEntries]);

  const moveChatCard = useCallback((id: number, x: number, y: number) => {
    setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, [setChatCards]);

  const resizeChatCard = useCallback((id: number, w: number, h: number) => {
    setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, [setChatCards]);

  const closeChatCard = useCallback((id: number) => {
    const target = chatCards.find((card) => card.id === id);
    setChatCards((previous) => previous.filter((card) => card.id !== id));
    if (!target) return;
    const lanes = [`thread:${target.threadId}`];
    if (target.repoPath && orch.threadIdFor(target.repoPath) === target.threadId) lanes.push(target.repoPath);
    setConvos((previous) => removeCanvasConversations(previous, lanes));
    firstOutputRef.current.delete(lanes[0]!);
    clearCanvasTurnAccumulators(lanes[0]!, turnTextRef.current, turnToolsRef.current);
  }, [chatCards, orch, setChatCards]);

  /** Promote a chat card into the dock — adopt its thread on the live
   *  socket; the next composer message continues that conversation. */
  const dockChatCard = useCallback((card: ChatCard) => {
    const repo = card.repoPath ?? activeRepoPath;
    if (!repo) return;
    setActiveRepoPath(repo);
    orch.adoptThread(repo, card.threadId);
    setConvos((previous) => setCanvasConversation(previous, repo, previous[`thread:${card.threadId}`] ?? card.entries));
    setChatCards((previous) => previous.filter((existing) => existing.id !== card.id));
    setDockOpen(true);
  }, [activeRepoPath, orch, setChatCards]);

  /** Undock the live orchestrator back onto the canvas as a floating chat card
   *  — the exact inverse of dockChatCard. The conversation KEEPS rendering
   *  (the bug was that undock hid the transcript entirely: dockOpen=false with
   *  nothing below it). The lane stays live the whole time — the `orch` socket
   *  never unsubscribes from activeRepoPath — so convos[repo] is the source and
   *  the card's own thread socket picks up exactly where the dock left off. The
   *  same dock button folds it back in via redockActiveLane. */
  const undockToCard = useCallback(() => {
    const repo = activeRepoPath;
    if (!repo) { setDockOpen(false); return; }
    const threadId = orch.threadIdFor(repo);
    const entries = convos[repo] ?? [];
    // No thread yet / empty lane — nothing conversable to float; just hide.
    if (!threadId || entries.length === 0) { setDockOpen(false); return; }
    // Already on the canvas as a card — don't spawn a duplicate, just hide.
    if (chatCards.some((card) => card.threadId === threadId)) { setDockOpen(false); return; }
    const name = repos?.find((r) => r.path === repo)?.name ?? null;
    const firstUser = entries.find((entry) => entry.role === 'user');
    const title = firstUser && firstUser.role === 'user' && firstUser.text.trim()
      ? firstUser.text.trim().slice(0, 60)
      : (name ?? 'Orchestrator');
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(380, 400);
    // Seed the card's live lane from the dock lane so its transcript is there
    // on first paint and its socket streams onto the same conversation.
    setConvos((previous) => setCanvasConversation(previous, `thread:${threadId}`, previous[repo] ?? entries));
    setChatCards((previous) => [...previous, {
      id,
      threadId,
      repoPath: repo,
      repoName: name,
      title,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 380,
      h: 400,
      entries,
    }]);
    setDockOpen(false);
  }, [activeRepoPath, convos, orch, repos, chatCards, findFreeSpot, setChatCards, zPeakRef]);

  /** Re-dock the active lane — if it's floating as a card, fold that exact card
   *  back in via dockChatCard (which adopts the card's thread lane, the complete
   *  record incl. anything typed in the card, back onto the dock). Otherwise
   *  just open the dock on the active lane. */
  const redockActiveLane = useCallback(() => {
    const repo = activeRepoPath;
    const threadId = repo ? orch.threadIdFor(repo) : null;
    if (repo && threadId) {
      const card = chatCards.find((existing) => existing.threadId === threadId);
      if (card) { dockChatCard(card); return; }
    }
    setDockOpen(true);
  }, [activeRepoPath, orch, chatCards, dockChatCard]);

  return {
    pickThread,
    noteCardSend,
    moveChatCard,
    resizeChatCard,
    closeChatCard,
    dockChatCard,
    undockToCard,
    redockActiveLane,
  };
}
