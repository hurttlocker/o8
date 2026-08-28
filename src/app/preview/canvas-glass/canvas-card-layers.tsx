'use client';

import type { ComponentProps, ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { AgentGlassCard, type AgentCard } from './agent-card';
import { BrainGlassCard, type BrainCard } from './brain-card';
import { BrowserGlassCard, type BrowserCard } from './browser-card';
import { ChatGlassCard, type ChatCard } from './chat-card';
import { DiffGlassCard, type DiffCard } from './diff-card';
import type { DispatchLane } from './dispatch-dock';
import { FileGlassCard, type FileCard } from './file-card';
import { FileTreeCardLayer, type FileTreeCard } from './file-tree-card';
import { ImageGlassCard, type ImageCard } from './image-card';
import { MarkdownGlassCard, type MarkdownCard } from './markdown-card';
import { SpecGlassCard, type SpecCard } from './spec-card';
import { TerminalGlassCard, type TermCard } from './terminal-card';
import { VideoGlassCard, type VideoCard } from './video-card';
import type { DockEntry } from './ui';

interface CanvasCardLayersProps {
  children?: ReactNode;
  canvasZoomLevel: number;
  pan: { x: number; y: number };
  termCards: TermCard[];
  fileCards: FileCard[];
  treeCards: FileTreeCard[];
  imageCards: ImageCard[];
  videoCards: VideoCard[];
  browserCards: BrowserCard[];
  diffCards: DiffCard[];
  agentCards: AgentCard[];
  brainCards: BrainCard[];
  markdownCards: MarkdownCard[];
  chatCards: ChatCard[];
  specCards: SpecCard[];
  activeLanes: DispatchLane[];
  convos: Record<string, DockEntry[]>;
  dropTargetId: number | null;
  specScreenMap: NonNullable<ComponentProps<typeof SpecGlassCard>['screenMap']>;
  terminal: Omit<ComponentProps<typeof TerminalGlassCard>, 'card'>;
  file: Omit<ComponentProps<typeof FileGlassCard>, 'card'>;
  tree: Omit<ComponentProps<typeof FileTreeCardLayer>, 'cards'>;
  image: Omit<ComponentProps<typeof ImageGlassCard>, 'card' | 'isDropTarget' | 'onTap' | 'onCycle'> & {
    cycleImageCard: (id: number, dir?: number) => void;
  };
  video: Omit<ComponentProps<typeof VideoGlassCard>, 'card'>;
  browser: Omit<ComponentProps<typeof BrowserGlassCard>, 'card'>;
  diff: Omit<ComponentProps<typeof DiffGlassCard>, 'card' | 'onChanged'>;
  agent: Omit<ComponentProps<typeof AgentGlassCard>, 'card' | 'lane'>;
  brain: Omit<ComponentProps<typeof BrainGlassCard>, 'card'>;
  markdown: Omit<ComponentProps<typeof MarkdownGlassCard>, 'card'>;
  chat: Omit<ComponentProps<typeof ChatGlassCard>, 'card' | 'liveEntries'>;
  spec: Omit<ComponentProps<typeof SpecGlassCard>, 'card' | 'screenMap'>;
}

export function CanvasCardLayers({
  children,
  canvasZoomLevel,
  pan,
  termCards,
  fileCards,
  treeCards,
  imageCards,
  videoCards,
  browserCards,
  diffCards,
  agentCards,
  brainCards,
  markdownCards,
  chatCards,
  specCards,
  activeLanes,
  convos,
  dropTargetId,
  specScreenMap,
  terminal,
  file,
  tree,
  image,
  video,
  browser,
  diff,
  agent,
  brain,
  markdown,
  chat,
  spec,
}: CanvasCardLayersProps) {
  const {
    termVeil,
    connectionEpoch: wsEpoch,
    onMove: moveTermCard,
    onResize: resizeTermCard,
    onFocus: focusTermCard,
    onClose: closeTerminal,
    onTermVeilChange: changeTermVeil,
    registerHandle: registerXtermHandle,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  } = terminal;
  const { onMove: moveFileCard, onResize: resizeFileCard, onFocus: focusFileCard, onClose: closeFileCard } = file;
  const { spawnFileCard, onMove: moveTreeCard, onResize: resizeTreeCard, onFocus: focusTreeCard, onClose: closeTreeCard } = tree;
  const {
    onMove: moveImageCard,
    onResize: resizeImageCard,
    onFocus: focusImageCard,
    onDrop: dropImageCard,
    cycleImageCard,
    onSpread: spreadImageCard,
    onClose: closeImageCard,
  } = image;
  const { onMove: moveVideoCard, onResize: resizeVideoCard, onFocus: focusVideoCard, onClose: closeVideoCard, onPoster: setVideoPoster } = video;
  const { onMove: moveBrowserCard, onResize: resizeBrowserCard, onFocus: focusBrowserCard, onTabsChange: changeBrowserTabs, onClose: closeBrowserCard } = browser;
  const {
    onMove: moveDiffCard,
    onResize: resizeDiffCard,
    onFocus: focusDiffCard,
    onClose: closeDiffCard,
    onRequestChanges: requestDiffCardChanges,
    onRefresh: refreshWorktreeDiffCard,
  } = diff;
  const {
    onMove: moveAgentCard,
    onResize: resizeAgentCard,
    onFocus: focusAgentCard,
    onClose: closeAgentCard,
    onReview: reviewAgentCard,
    onToggleExpand: toggleAgentCardExpand,
  } = agent;
  const { onMove: moveBrainCard, onResize: resizeBrainCard, onFocus: focusBrainCard, onClose: closeBrainCard } = brain;
  const { onMove: moveMarkdownCard, onResize: resizeMarkdownCard, onFocus: focusMarkdownCard, onClose: closeMarkdownCard } = markdown;
  const {
    sendDefaults: chatSendDefaults,
    onLiveEvent: handleOrchEvent,
    onUserSend: noteCardSend,
    onTruncate: truncateLane,
    onMove: moveChatCard,
    onResize: resizeChatCard,
    onFocus: focusChatCard,
    onDock: dockChatCard,
    onClose: closeChatCard,
  } = chat;
  const { onMove: moveSpecCard, onResize: resizeSpecCard, onFocus: focusSpecCard, onClose: closeSpecCard } = spec;

  return (
    <>
      <div data-canvas-layer style={{ position: 'absolute', inset: 0, zIndex: 2, zoom: canvasZoomLevel, transform: `translate(${pan.x}px, ${pan.y}px)`, willChange: 'transform' } as React.CSSProperties}>
        {children}

      {/* ── Real terminals (production transport, canvas treatment) ── */}
      <AnimatePresence>
        {termCards.map((card) => (
          <TerminalGlassCard
            key={card.id}
            card={card}
            termVeil={termVeil}
            connectionEpoch={wsEpoch}
            onMove={moveTermCard}
            onResize={resizeTermCard}
            onFocus={focusTermCard}
            onClose={closeTerminal}
            onTermVeilChange={changeTermVeil}
            registerHandle={registerXtermHandle}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
          />
        ))}
      </AnimatePresence>

      {/* ── File cards — any file on the machine, view/edit/save ──── */}
      <AnimatePresence>
        {fileCards.map((card) => (
          <FileGlassCard
            key={card.id}
            card={card}
            termVeil={termVeil}
            onMove={moveFileCard}
            onResize={resizeFileCard}
            onFocus={focusFileCard}
            onClose={closeFileCard}
          />
        ))}
      </AnimatePresence>

      <FileTreeCardLayer cards={treeCards} spawnFileCard={spawnFileCard} onMove={moveTreeCard}
        onResize={resizeTreeCard} onFocus={focusTreeCard} onClose={closeTreeCard} />

      {/* ── Image cards — photos dissolve into the canvas; drag together
            to stack, tap a deck to flip through ─────────────────────── */}
      <AnimatePresence>
        {imageCards.map((card) => (
          <ImageGlassCard
            key={card.id}
            card={card}
            isDropTarget={card.id === dropTargetId}
            onMove={moveImageCard}
            onResize={resizeImageCard}
            onFocus={focusImageCard}
            onDrop={dropImageCard}
            onTap={cycleImageCard}
            onCycle={cycleImageCard}
            onSpread={spreadImageCard}
            onClose={closeImageCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Video cards — UI clips that sit on the canvas for reference ── */}
      <AnimatePresence>
        {videoCards.map((card) => (
          <VideoGlassCard
            key={card.id}
            card={card}
            onMove={moveVideoCard}
            onResize={resizeVideoCard}
            onFocus={focusVideoCard}
            onClose={closeVideoCard}
            onPoster={setVideoPoster}
          />
        ))}
      </AnimatePresence>

      {/* ── Browser cards — a real page in glass ─────────────────── */}
      <AnimatePresence>
        {browserCards.map((card) => (
          <BrowserGlassCard
            key={card.id}
            card={card}
            onMove={moveBrowserCard}
            onResize={resizeBrowserCard}
            onFocus={focusBrowserCard}
            onTabsChange={changeBrowserTabs}
            onClose={closeBrowserCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Diff cards — the governance moat as canvas objects ────── */}
      <AnimatePresence>
        {diffCards.map((card) => (
          <DiffGlassCard
            key={card.id}
            card={card}
            onMove={moveDiffCard}
            onResize={resizeDiffCard}
            onFocus={focusDiffCard}
            onClose={closeDiffCard}
            onRequestChanges={requestDiffCardChanges}
            onRefresh={refreshWorktreeDiffCard}
            onChanged={refreshWorktreeDiffCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Agent cards — dispatched workers as canvas objects (voice spawn) ─ */}
      <AnimatePresence>
        {agentCards.map((card) => (
          <AgentGlassCard
            key={card.id}
            card={card}
            lane={activeLanes.find((lane) => lane.id === card.laneId) ?? null}
            onMove={moveAgentCard}
            onResize={resizeAgentCard}
            onFocus={focusAgentCard}
            onClose={closeAgentCard}
            onReview={reviewAgentCard}
            onToggleExpand={toggleAgentCardExpand}
          />
        ))}
      </AnimatePresence>

      {/* o8.md cards render in a SEPARATE overlay OUTSIDE this zoom layer (just
          after it) — CodeMirror caret hit-testing breaks under any CSS scale, so
          they render at true device-1:1 and scale numerically instead (#1241). */}

      {/* ── Brain cards — instant cited repo answers, on the canvas ── */}
      <AnimatePresence>
        {brainCards.map((card) => (
          <BrainGlassCard
            key={card.id}
            card={card}
            onMove={moveBrainCard}
            onResize={resizeBrainCard}
            onFocus={focusBrainCard}
            onClose={closeBrainCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Markdown cards — orchestrator-rendered explainers (#1270) ── */}
      <AnimatePresence>
        {markdownCards.map((card) => (
          <MarkdownGlassCard
            key={card.id}
            card={card}
            onMove={moveMarkdownCard}
            onResize={resizeMarkdownCard}
            onFocus={focusMarkdownCard}
            onClose={closeMarkdownCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Chat cards — past sessions as their own glass boxes ───── */}
      <AnimatePresence>
        {chatCards.map((card) => (
          <ChatGlassCard
            key={card.id}
            card={card}
            liveEntries={convos[`thread:${card.threadId}`] ?? null}
            sendDefaults={chatSendDefaults}
            onLiveEvent={handleOrchEvent}
            onUserSend={noteCardSend}
            onTruncate={truncateLane}
            onMove={moveChatCard}
            onResize={resizeChatCard}
            onFocus={focusChatCard}
            onDock={dockChatCard}
            onClose={closeChatCard}
          />
        ))}
      </AnimatePresence>

      </div>

      {/* ── o8.md overlay — OUTSIDE the zoom layer so CodeMirror renders at true
            device-1:1 (WebKit caret hit-testing breaks under ANY CSS scale in
            the ancestry — even a nested counter-scale to net-1.0; proven). Each
            card maps its layer-local x/y to screen via screenMap = zoom·(coord+
            pan) and scales its own size + chrome + editor NUMERICALLY by the
            zoom, so it looks identical to an in-layer card but the caret works
            everywhere (#1241). Container is pointerEvents:none (empty canvas
            stays clickable); each card opts back in. zIndex 3 = above the canvas
            layer (2), below the chrome (40+). */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' } as React.CSSProperties}>
        <AnimatePresence>
          {specCards.map((card) => (
            <SpecGlassCard
              key={card.id}
              card={card}
              screenMap={specScreenMap}
              onMove={moveSpecCard}
              onResize={resizeSpecCard}
              onFocus={focusSpecCard}
              onClose={closeSpecCard}
            />
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
