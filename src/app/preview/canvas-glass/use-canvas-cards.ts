'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_COMPACT_H, AGENT_COMPACT_W, AGENT_FULL_H, AGENT_FULL_W, type AgentCard } from './agent-card';
import type { BrainCard } from './brain-card';
import type { BrowserCard } from './browser-card';
import type { CanvasCardLite } from './canvas-card-intents';
import { moveCanvasCard } from './canvas-card-state';
import { CANVAS_CARD_KINDS, type CanvasCardKind } from './canvas-commands';
import type { ChatCard } from './chat-card';
import type { DiffCard } from './diff-card';
import type { FileCard } from './file-card';
import type { FileTreeCard } from './file-tree-card';
import type { ImageCard } from './image-card';
import type { MarkdownCard } from './markdown-card';
import type { SpecCard } from './spec-card';
import type { TermCard } from './terminal-card';
import type { VideoCard } from './video-card';

export function useCanvasCards() {
  const canvasCardKinds = CANVAS_CARD_KINDS;
  const [termCards, setTermCards] = useState<TermCard[]>([]);
  const [fileCards, setFileCards] = useState<FileCard[]>([]);
  const [treeCards, setTreeCards] = useState<FileTreeCard[]>([]);
  const [imageCards, setImageCards] = useState<ImageCard[]>([]);
  const imageCardsRef = useRef<ImageCard[]>([]);
  imageCardsRef.current = imageCards;
  const [videoCards, setVideoCards] = useState<VideoCard[]>([]);
  const [diffCards, setDiffCards] = useState<DiffCard[]>([]);
  const [specCards, setSpecCards] = useState<SpecCard[]>([]);
  const [brainCards, setBrainCards] = useState<BrainCard[]>([]);
  const [markdownCards, setMarkdownCards] = useState<MarkdownCard[]>([]);
  const [agentCards, setAgentCards] = useState<AgentCard[]>([]);
  const [browserCards, setBrowserCards] = useState<BrowserCard[]>([]);
  const [chatCards, setChatCards] = useState<ChatCard[]>([]);

  // Terminals + file cards share one z band (10–39, chrome at 40+) so
  // clicking ANY card brings it above every other card kind.
  const zPeakRef = useRef(9);

  // ── Canvas control surface (agent parity) ────────────────────────────────
  // The intent bus's card verbs let an agent drive the canvas the way a human
  // can: SEE every card (list), then move / resize / focus / close one by id.
  // Existing focus/close handlers preserve each kind's teardown semantics.
  //
  // canvasCardsRef holds the latest card arrays so `list` + verb existence
  // checks read fresh state WITHOUT re-subscribing the intent listener on every
  // card change. Synced in an effect (not during render) — intents fire from
  // event handlers, long after commit, so one-tick lag never bites.
  const canvasCardsRef = useRef<Record<CanvasCardKind, CanvasCardLite[]>>({
    term: [], file: [], tree: [], image: [], video: [], browser: [], chat: [], diff: [], spec: [], brain: [], markdown: [], agent: [],
  });
  useEffect(() => {
    canvasCardsRef.current = {
      term: termCards, file: fileCards, tree: treeCards, image: imageCards, video: videoCards, browser: browserCards,
      chat: chatCards, diff: diffCards, spec: specCards, brain: brainCards, markdown: markdownCards, agent: agentCards,
    };
  }, [termCards, fileCards, treeCards, imageCards, videoCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards, agentCards]);

  const findCanvasCard = useCallback((kind: CanvasCardKind, id: number) => {
    return canvasCardsRef.current[kind].find((card) => card.id === id) ?? null;
  }, []);

  const moveTermCard = useCallback((id: number, x: number, y: number) => {
    setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeTermCard = useCallback((id: number, w: number, h: number) => {
    setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  /** Clicked card comes forward. Terminals + files + images + browsers +
   *  chats share the 10–39 band — above mock cards (3), below chrome (40+). */
  const focusCard = useCallback((kind: CanvasCardKind, id: number) => {
    const canvasCards = canvasCardsRef.current;
    const current = canvasCards[kind].find((card) => card.id === id);
    if (!current || current.z === zPeakRef.current) return;
    if (zPeakRef.current + 1 > 38) {
      // Renormalize the whole band, keeping order, with the target on top.
      const combined = canvasCardKinds.flatMap((cardKind) => (
        canvasCards[cardKind].map((card) => ({ kind: cardKind, id: card.id, z: card.z }))
      )).sort((a, b) => a.z - b.z);
      const remap = new Map(combined.map((entry, index) => [`${entry.kind}:${entry.id}`, 10 + index]));
      const top = 10 + combined.length;
      setTermCards((previous) => previous.map((card) => ({ ...card, z: kind === 'term' && card.id === id ? top : remap.get(`term:${card.id}`) ?? card.z })));
      setFileCards((previous) => previous.map((card) => ({ ...card, z: kind === 'file' && card.id === id ? top : remap.get(`file:${card.id}`) ?? card.z })));
      setTreeCards((previous) => previous.map((card) => ({ ...card, z: kind === 'tree' && card.id === id ? top : remap.get(`tree:${card.id}`) ?? card.z })));
      setImageCards((previous) => previous.map((card) => ({ ...card, z: kind === 'image' && card.id === id ? top : remap.get(`image:${card.id}`) ?? card.z })));
      setVideoCards((previous) => previous.map((card) => ({ ...card, z: kind === 'video' && card.id === id ? top : remap.get(`video:${card.id}`) ?? card.z })));
      setBrowserCards((previous) => previous.map((card) => ({ ...card, z: kind === 'browser' && card.id === id ? top : remap.get(`browser:${card.id}`) ?? card.z })));
      setChatCards((previous) => previous.map((card) => ({ ...card, z: kind === 'chat' && card.id === id ? top : remap.get(`chat:${card.id}`) ?? card.z })));
      setDiffCards((previous) => previous.map((card) => ({ ...card, z: kind === 'diff' && card.id === id ? top : remap.get(`diff:${card.id}`) ?? card.z })));
      setSpecCards((previous) => previous.map((card) => ({ ...card, z: kind === 'spec' && card.id === id ? top : remap.get(`spec:${card.id}`) ?? card.z })));
      setBrainCards((previous) => previous.map((card) => ({ ...card, z: kind === 'brain' && card.id === id ? top : remap.get(`brain:${card.id}`) ?? card.z })));
      setMarkdownCards((previous) => previous.map((card) => ({ ...card, z: kind === 'markdown' && card.id === id ? top : remap.get(`markdown:${card.id}`) ?? card.z })));
      setAgentCards((previous) => previous.map((card) => ({ ...card, z: kind === 'agent' && card.id === id ? top : remap.get(`agent:${card.id}`) ?? card.z })));
      zPeakRef.current = top;
      return;
    }
    zPeakRef.current += 1;
    const z = zPeakRef.current;
    if (kind === 'term') {
      setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'file') {
      setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'tree') {
      setTreeCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'image') {
      setImageCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'video') {
      setVideoCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'browser') {
      setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'chat') {
      setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'diff') {
      setDiffCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'spec') {
      setSpecCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'brain') {
      setBrainCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'markdown') {
      setMarkdownCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else {
      setAgentCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    }
  }, []);

  const focusTermCard = useCallback((id: number) => focusCard('term', id), [focusCard]);
  const focusFileCard = useCallback((id: number) => focusCard('file', id), [focusCard]);
  const focusTreeCard = useCallback((id: number) => focusCard('tree', id), [focusCard]);
  const focusImageCard = useCallback((id: number) => focusCard('image', id), [focusCard]);
  const focusVideoCard = useCallback((id: number) => focusCard('video', id), [focusCard]);
  const focusBrowserCard = useCallback((id: number) => focusCard('browser', id), [focusCard]);
  const focusChatCard = useCallback((id: number) => focusCard('chat', id), [focusCard]);
  const focusDiffCard = useCallback((id: number) => focusCard('diff', id), [focusCard]);
  const focusSpecCard = useCallback((id: number) => focusCard('spec', id), [focusCard]);
  const focusBrainCard = useCallback((id: number) => focusCard('brain', id), [focusCard]);
  const focusMarkdownCard = useCallback((id: number) => focusCard('markdown', id), [focusCard]);
  const focusAgentCard = useCallback((id: number) => focusCard('agent', id), [focusCard]);
  const moveDiffCard = useCallback((id: number, x: number, y: number) => setDiffCards((previous) => moveCanvasCard(previous, id, x, y)), []);
  const resizeDiffCard = useCallback((id: number, w: number, h: number) => setDiffCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card))), []);
  const closeDiffCard = useCallback((id: number) => setDiffCards((previous) => previous.filter((card) => card.id !== id)), []);
  const moveAgentCard = useCallback((id: number, x: number, y: number) => setAgentCards((previous) => moveCanvasCard(previous, id, x, y)), []);
  const resizeAgentCard = useCallback((id: number, w: number, h: number) => setAgentCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card))), []);
  const closeAgentCard = useCallback((id: number) => setAgentCards((previous) => previous.filter((card) => card.id !== id)), []);
  const moveBrainCard = useCallback((id: number, x: number, y: number) => setBrainCards((previous) => moveCanvasCard(previous, id, x, y)), []);
  const resizeBrainCard = useCallback((id: number, w: number, h: number) => setBrainCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card))), []);
  const closeBrainCard = useCallback((id: number) => setBrainCards((previous) => previous.filter((card) => card.id !== id)), []);
  const moveMarkdownCard = useCallback((id: number, x: number, y: number) => setMarkdownCards((previous) => moveCanvasCard(previous, id, x, y)), []);
  const resizeMarkdownCard = useCallback((id: number, w: number, h: number) => setMarkdownCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card))), []);
  const closeMarkdownCard = useCallback((id: number) => setMarkdownCards((previous) => previous.filter((card) => card.id !== id)), []);
  const moveSpecCard = useCallback((id: number, x: number, y: number) => setSpecCards((previous) => moveCanvasCard(previous, id, x, y)), []);
  const resizeSpecCard = useCallback((id: number, w: number, h: number) => setSpecCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card))), []);
  const closeSpecCard = useCallback((id: number) => setSpecCards((previous) => previous.filter((card) => card.id !== id)), []);

  /** Toggle an agent card compact ↔ full — snaps to that mode's preset size so
   *  the transcript+composer get room in full and the status tile stays tight in
   *  compact. The o8_canvas resize verb still resizes either mode afterward. */
  const toggleAgentCardExpand = useCallback((id: number) => {
    setAgentCards((previous) => previous.map((card) => (
      card.id === id
        ? card.expanded
          ? { ...card, expanded: false, w: AGENT_COMPACT_W, h: AGENT_COMPACT_H }
          : { ...card, expanded: true, w: AGENT_FULL_W, h: AGENT_FULL_H }
        : card
    )));
  }, []);

  const moveFileCard = useCallback((id: number, x: number, y: number) => {
    setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeFileCard = useCallback((id: number, w: number, h: number) => {
    setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  const closeFileCard = useCallback((id: number) => {
    setFileCards((previous) => previous.filter((card) => card.id !== id));
  }, []);

  const moveTreeCard = useCallback((id: number, x: number, y: number) => setTreeCards((previous) => moveCanvasCard(previous, id, x, y)), []);
  const resizeTreeCard = useCallback((id: number, w: number, h: number) => setTreeCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card))), []);
  const closeTreeCard = useCallback((id: number) => setTreeCards((previous) => previous.filter((card) => card.id !== id)), []);

  return {
    termCards, setTermCards, fileCards, setFileCards, treeCards, setTreeCards,
    imageCards, setImageCards, imageCardsRef, videoCards, setVideoCards,
    diffCards, setDiffCards, specCards, setSpecCards, brainCards, setBrainCards,
    markdownCards, setMarkdownCards, agentCards, setAgentCards,
    browserCards, setBrowserCards, chatCards, setChatCards,
    zPeakRef, canvasCardsRef, findCanvasCard, focusCard,
    focusTermCard, focusFileCard, focusTreeCard, focusImageCard, focusVideoCard,
    focusBrowserCard, focusChatCard, focusDiffCard, focusSpecCard, focusBrainCard,
    focusMarkdownCard, focusAgentCard, moveTermCard, resizeTermCard,
    moveFileCard, resizeFileCard, closeFileCard, moveTreeCard, resizeTreeCard,
    closeTreeCard, moveDiffCard, resizeDiffCard, closeDiffCard,
    moveAgentCard, resizeAgentCard, closeAgentCard,
    moveBrainCard, resizeBrainCard, closeBrainCard,
    moveMarkdownCard, resizeMarkdownCard, closeMarkdownCard,
    moveSpecCard, resizeSpecCard, closeSpecCard, toggleAgentCardExpand,
  };
}
