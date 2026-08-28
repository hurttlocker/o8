'use client';

/**
 * The docked orchestrator — a persistent companion rail beside the canvas (#1232).
 * Opt-in: the conversation lives at the bottom composer until the operator
 * docks it. The dock floats directly on the canvas (no hard panel — it
 * fades in), shows every running orchestrator as a switcher row, and the
 * selected one's conversation streams in with soft fades: prompt bubble,
 * status line, result card, explanation text, numbered follow-ups.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { FONT, TONE_DOT, glassPop, scrollFadeY, type DockEntry, type OrchestratorLane } from './ui';
import { useScrollBlurFade } from './use-scroll-blur-fade';
import { ReasoningView } from './reasoning';
import { SwarmStatusCard, type SwarmScoutView } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import { useSmoothText } from '@/components/desktop/thoughts/chat-panel/use-smooth-text';
import { BrainConversation } from './brain-card';
import { CardComposer } from './card-composer';
import { FilesResult, PrResult, ScreenshotResult } from './response-blocks';
import { TurnPlaybackBar } from './turn-playback';
import { QueuedSends, UndoSendPill, SEND_UNDO_GRACE_MS, type QueuedSend } from './use-send-buffer';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

/** The reference's spark — marks a settled turn-status line. */
function SparkGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ flexShrink: 0 }}>
      <path d="M12 3l1.9 6.4a1 1 0 0 0 .7.7L21 12l-6.4 1.9a1 1 0 0 0-.7.7L12 21l-1.9-6.4a1 1 0 0 0-.7-.7L3 12l6.4-1.9a1 1 0 0 0 .7-.7z" />
    </svg>
  );
}

export function OrchestratorDock({
  lanes,
  entries,
  activeLane,
  activeLabel,
  onSelectLane,
  onSend,
  busy,
  queued,
  onCancelQueued,
  undoArmed,
  onUndoSend,
  onClose,
  scouts = [],
}: {
  /** Lanes with a running conversation — the dropdown's contents. */
  lanes: OrchestratorLane[];
  entries: DockEntry[];
  activeLane: string;
  /** Live native-Claude scouts (Task-tool fan-out) for the active lane. */
  scouts?: SwarmScoutView[];
  activeLabel: string;
  activeTone: OrchestratorLane['tone'];
  onSelectLane: (id: string) => void;
  /** Send a reply from the dock's own composer. */
  onSend: (message: string) => void;
  busy: boolean;
  /** Messages waiting for the current turn to finish (shared main-convo queue). */
  queued: QueuedSend[];
  onCancelQueued: (id: number) => void;
  /** A just-sent message is still inside the undo-send grace window. */
  undoArmed: boolean;
  onUndoSend: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useScrollBlurFade(scrollRef);
  const [activeTab, setActiveTab] = useState<'orchestrator' | 'cortex'>('orchestrator');
  const [laneMenuOpen, setLaneMenuOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const laneMenuRef = useRef<HTMLDivElement | null>(null);
  const laneButtonRef = useRef<HTMLButtonElement | null>(null);

  // Stick the transcript to the bottom as the orchestrator streams. The
  // [entries] identity alone misses in-place delta growth (text streamed into
  // an existing entry), which left the panel frozen at the top while output
  // piled up below the fold. Observe the DOM directly instead: ResizeObserver
  // catches card/text height growth, MutationObserver catches new nodes +
  // streamed characters. Pin only when the reader is already near the bottom,
  // so scrolling up to read history isn't yanked back down. Re-binds on
  // activeTab because the scroll container unmounts on the Cortex tab.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let stick = true;
    let raf = 0;
    const pin = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (stick && node) node.scrollTop = node.scrollHeight;
      });
    };
    const onScroll = () => {
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    Array.from(el.children).forEach((child) => ro.observe(child));
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) ro.observe(node);
        });
      }
      pin();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    pin();
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [activeTab]);

  // The dock sits inside a transformed ancestor, so a fixed veil would
  // anchor to the panel, not the viewport — dismiss via document listeners
  // instead (outside pointerdown + Escape), like every other popover.
  useEffect(() => {
    if (!laneMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (laneMenuRef.current?.contains(target) || laneButtonRef.current?.contains(target)) return;
      setLaneMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLaneMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [laneMenuOpen]);

  const otherLanes = lanes.filter((lane) => lane.id !== activeLane);

  // The orchestrator tab wears the active lane's NAME instead of the generic
  // "Orchestrator" (Q: save space + identify the chat — mirrors the chat-card
  // modal's name-tab). Truncated so it never overflows the strip; falls back to
  // "Orchestrator" for an unscoped/placeholder lane.
  const nameTab = (() => {
    const t = (activeLabel || '').trim();
    if (!t || t === '…') return 'Orchestrator';
    return t.length > 20 ? `${t.slice(0, 19).trimEnd()}…` : t;
  })();

  // Re-point the canvas vars to the dock's own dial (glass-settings stamps
  // --cnv-dock-*). Scoped to the dock surface, so lightening it never leaks
  // to the rest of the canvas; 'match' resolves these to the global values.
  const dockSurfaceVars = {
    ['--cnv-tint' as string]: 'var(--cnv-dock-tint)',
    ['--cnv-tint-deep' as string]: 'var(--cnv-dock-tint-deep)',
    ['--cnv-ink' as string]: 'var(--cnv-dock-ink)',
    ['--cnv-ink-muted' as string]: 'var(--cnv-dock-ink-muted)',
    ['--cnv-edge' as string]: 'var(--cnv-dock-edge)',
    ['--cnv-pop-tint' as string]: 'var(--cnv-dock-pop-tint)',
    ['--cnv-pop-base' as string]: 'var(--cnv-dock-pop-base)',
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 36 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 36 }}
      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
      data-glass-surface
      style={{
        // Pin to the VIEWPORT, not the nearest positioned ancestor. As an
        // absolute child the dock anchored to a SmoothCorners wrapper whose box
        // could sit wider than the window, so right:24 landed off-screen and the
        // Cortex tab + ✕ undock were unreachable ("cut off at all times, can't
        // undock"). The dock lives OUTSIDE the zoom/pan canvas layer, so fixed is
        // safe (no transformed ancestor) and tracks the window edge exactly.
        position: 'fixed',
        top: 74,
        right: 24,
        bottom: 96,
        width: 400,
        // Never wider than the window — on a narrow window the dock shrinks
        // instead of pushing its right edge (and the undock ✕) off-screen.
        maxWidth: 'calc(100vw - 48px)',
        zIndex: 43,
        fontFamily: FONT,
        // SmoothCorners (autoEffects) wraps our surface in an extra unstyled
        // `position:relative` div — that breaks the height:100% chain, so a
        // single `auto` grid row would size to the TRANSCRIPT and overflow the
        // pinned bounds (composer falls off the bottom). `minmax(0, 1fr)` pins
        // the one row to the container's definite height (top/bottom) and the
        // 0-floor stops content from blowing it out — the wrapper fills it, our
        // height:100% surface resolves, the transcript scrolls, composer stays.
        display: 'grid',
        gridTemplateRows: 'minmax(0, 1fr)',
        // SAME minmax(0,1fr) trick on the COLUMN axis — the row pin alone left
        // the implicit column `auto`, so a wide child (the SmoothCorners shape
        // SVG / a long unbroken transcript line) grew the track to its
        // min-content width (~814px), overflowing the 400px panel to the RIGHT
        // and shoving the ✕ undock + Cortex tab off-screen. The 0-floor caps the
        // column at the panel width so content wraps/clips inside it instead.
        gridTemplateColumns: 'minmax(0, 1fr)',
      }}
    >
      {/* No hard panel — the dock FADES into the canvas on its left; the solid
          right side gets the Apple-smooth per-corner clip. The dock is PINNED
          (not a floating card — that role belongs to the chat-card modal), so
          there's no drag/resize and no per-frame backdrop re-sample to flicker. */}
      <SmoothCorners
        corners={{ radius: 22 }}
        shadowStrategy="box-shadow"
        style={{
          ...dockSurfaceVars,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          // Content can never push the panel past its pinned bounds — the
          // transcript scrolls, the panel doesn't grow.
          overflow: 'hidden',
          color: 'var(--cnv-ink)',
          // SOLID surface + blur, the agent-card bench treatment (Q: "make the
          // edge solid like the test"). The dock used to fade into the canvas
          // on a veil gradient that collapsed to fully transparent at the
          // default dockTint:0; now it's a defined card with a solid edge. The
          // dock is PINNED (no drag), so the backdrop blur can't trigger the
          // drag flicker. The shadow lifts it — the drop matches the bench, and
          // a left component defines the tall panel's open edge in light mode
          // (near-white surface on a near-white canvas).
          background: 'var(--cnv-tint-deep)',
          backdropFilter: 'blur(calc(var(--cnv-frost) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
          WebkitBackdropFilter: 'blur(calc(var(--cnv-frost) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
          boxShadow: '0 14px 42px rgba(0, 0, 0, 0.22), -14px 0 40px -18px rgba(8, 12, 20, 0.14)',
        } as React.CSSProperties}
      >
        {/* Tabs — the orchestrator NEVER rides without its Cortex side; both
            share the one pane, smooth + borderless (no underline, no divider —
            Q's reference). The ✕ undocks (the conversation returns to the
            composer below). The dock is pinned, so this strip is the panel's
            only chrome — no drag bar. */}
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 18, paddingRight: 10, paddingTop: 11, flexShrink: 0 }}>
          <div role="tablist" aria-label="Orchestrator panel views" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', flex: 1 }}>
            <DockTab label={nameTab} active={activeTab === 'orchestrator'} onClick={() => setActiveTab('orchestrator')} />
            <DockTab label="Cortex" active={activeTab === 'cortex'} onClick={() => { setActiveTab('cortex'); setLaneMenuOpen(false); }} />
          </div>
          <button
            type="button"
            aria-label="Undock"
            onClick={onClose}
            style={{ borderWidth: 0, background: 'transparent', paddingTop: 2, paddingBottom: 9, paddingLeft: 6, paddingRight: 6, fontSize: 11, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>

        {/* Both tabs fill the pinned panel's remaining height — its bounds are
            fixed (top/bottom), so the transcript scrolls inside, never grows. */}
        {activeTab === 'cortex' ? (
          <BrainConversation repoPath={activeLane || null} />
        ) : (
          <>
            {/* Lane switcher — only when another orchestrator is actually
                running. The active lane's name now lives in the tab, so with
                nothing to switch to this row is pure duplicate chrome; hiding it
                reclaims height and keeps the composer in view. */}
            {otherLanes.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 9, paddingBottom: 7, paddingLeft: 14, paddingRight: 12, position: 'relative', flexShrink: 0 }}>
              <button
                ref={laneButtonRef}
                type="button"
                aria-label="Switch orchestrator"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setLaneMenuOpen((value) => !value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  borderWidth: 0,
                  background: 'transparent',
                  paddingTop: 2,
                  paddingBottom: 2,
                  paddingLeft: 2,
                  paddingRight: 2,
                  cursor: 'pointer',
                  fontFamily: FONT,
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)' }}>{activeLabel}</span>
                <svg
                  width={10}
                  height={10}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--cnv-ink-muted)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  style={{ transform: laneMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease' }}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {/* Dropdown — only orchestrators that are actually running. */}
              <AnimatePresence>
                {laneMenuOpen ? (
                  <motion.div
                    ref={laneMenuRef}
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                    style={{
                      position: 'absolute',
                      top: 38,
                      left: 12,
                      width: 224,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 6,
                      paddingRight: 6,
                      borderRadius: 13,
                      zIndex: 5,
                      ...glassPop(),
                    }}
                  >
                    {otherLanes.map((lane) => (
                        <button
                          key={lane.id}
                          type="button"
                          onClick={() => {
                            onSelectLane(lane.id);
                            setLaneMenuOpen(false);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            paddingTop: 6,
                            paddingBottom: 6,
                            paddingLeft: 8,
                            paddingRight: 8,
                            borderRadius: 9,
                            borderWidth: 0,
                            background: 'transparent',
                            cursor: 'pointer',
                            fontFamily: FONT,
                            textAlign: 'left',
                          }}
                          onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                        >
                          <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_DOT[lane.tone], flexShrink: 0 }} />
                          <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px' }}>{lane.label}</span>
                        </button>
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            ) : null}

            {/* Conversation. */}
            <div
              ref={scrollRef}
              style={{ ...scrollFadeY, flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 14, paddingRight: 14, paddingBottom: 14, scrollbarWidth: 'none' } as React.CSSProperties}
              onClick={() => {
                if (laneMenuOpen) setLaneMenuOpen(false);
              }}
            >
              <AnimatePresence initial={false}>
                {entries.map((entry) => (
                  <DockEntryView key={entry.id} entry={entry} />
                ))}
              </AnimatePresence>
              {scouts.length > 0 ? <SwarmStatusCard packets={[]} scouts={scouts} /> : null}
              {entries.length === 0 ? (
                <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.6 }}>
                  No conversation on this lane yet — message the orchestrator below.
                </span>
              ) : null}
            </div>

            {/* Reply right here — the card owns its own composer (shared with
                the chat-card: field-sizing textarea + Input Anticipation ring).
                Sending while busy QUEUES (the default composer's behavior); a
                just-sent message can still be taken back via the undo pill. */}
            <div style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 12, paddingTop: 4, flexShrink: 0 }}>
              <QueuedSends items={queued} onCancel={onCancelQueued} />
              <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: undoArmed ? 6 : 0 }}>
                <AnimatePresence>
                  {undoArmed ? <UndoSendPill key="undo" onUndo={onUndoSend} graceMs={SEND_UNDO_GRACE_MS} /> : null}
                </AnimatePresence>
              </div>
              <CardComposer
                value={draft}
                onChange={setDraft}
                busy={false}
                model="Opus 4.8"
                anticipate
                placeholder={busy ? `Queue a follow-up to ${activeLabel}…` : `Reply to ${activeLabel}`}
                onSubmit={() => {
                  const prompt = draft.trim();
                  if (!prompt) return;
                  onSend(prompt);
                  setDraft('');
                }}
              />
            </div>
          </>
        )}
      </SmoothCorners>
    </motion.div>
  );
}

/** One pane-header tab — Orchestrator | Cortex. Borderless (Q's reference):
 *  no underline, no box — the active tab is a weight + ink + opacity shift.
 *  Exported: the chat-card orchestrator modal renders the same strip. */
export function DockTab({ label, active, onClick, size = 14, truncate = false }: { label: string; active: boolean; onClick: () => void; size?: number; truncate?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={truncate ? label : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      style={{
        borderWidth: 0,
        background: 'transparent',
        paddingTop: 0,
        paddingBottom: 9,
        paddingLeft: 2,
        paddingRight: 2,
        cursor: 'pointer',
        fontFamily: FONT,
        fontSize: size,
        // Active is distinguished by color + opacity, NOT weight (hurttlocker
        // locked rule: "active state never bumps weight"). The old active-500
        // made the chat card's title tab read heavier than every other card's
        // weight-400 title — the "chat vs o8 panel different sizes" the operator
        // caught on the dogfood run. 400 matches CHROME.titleWeight everywhere.
        fontWeight: 400,
        letterSpacing: '-0.2px',
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        opacity: active ? 1 : 0.7,
        transition: 'color 160ms ease, opacity 160ms ease',
        // Truncate mode (the conversation-title tab): shrink + ellipsis inside a
        // flex row so a long title never pushes the layout or clips the corner.
        ...(truncate ? { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : null),
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.opacity = '0.7'; }}
    >
      {label}
    </button>
  );
}

/** Shared by the dock AND the floating chat cards — one entry vocabulary.
 *  Borderless throughout (Q's reference): user = soft pill, result + prose flow
 *  on the glass, no boxed cards or divider lines. */
export function DockEntryView({ entry }: { entry: DockEntry }) {
  // Smooth streaming reveal for the assistant's prose — same hook the desktop
  // chat uses (DesktopAgentMessage). Called unconditionally (rules of hooks);
  // it only animates while a 'text' entry is live, otherwise returns the full
  // text immediately. revealedText is consumed only in the text branch below.
  const revealedText = useSmoothText(
    entry.role === 'text' ? entry.text : '',
    entry.role === 'text' && entry.live === true,
  );
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      {entry.role === 'user' ? (
        <div
          style={{
            alignSelf: 'flex-end',
            // % not a fixed px so the bubble reads as a real right-aligned chat
            // bubble at ANY container width — 300px looked right in the 400px
            // dock but shrank to a lost narrow column in the wider undocked
            // card. 80% ≈ the dock's old 300px, and scales with the card.
            maxWidth: '80%',
            display: 'flex',
            flexDirection: 'column',
            gap: entry.images?.length ? 7 : 0,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 15,
            fontSize: 12.5,
            fontWeight: 300,
            lineHeight: 1.5,
            letterSpacing: '-0.1px',
            background: 'var(--cnv-tint)',
          }}
        >
          {entry.images?.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {entry.images.map((src, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={index}
                  src={src}
                  alt=""
                  style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 9, border: '1px solid var(--cnv-edge)' }}
                />
              ))}
            </div>
          ) : null}
          {entry.text ? <span>{entry.text}</span> : null}
        </div>
      ) : null}
      {entry.role === 'thinking' ? (
        <ReasoningView text={entry.text} live={entry.live === true} startedAt={entry.startedAt} marks={entry.marks} />
      ) : null}
      {entry.role === 'status' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {entry.pending && entry.kind !== 'tool' ? (
            <motion.span
              aria-hidden
              animate={{ rotate: 360 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
              style={{ width: 9, height: 9, borderRadius: '50%', borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)', flexShrink: 0 }}
            />
          ) : entry.kind === 'tool' ? (
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_DOT.working, flexShrink: 0 }} />
          ) : (
            // Settled turn status gets the reference's spark, not a dot.
            <span style={{ color: 'var(--cnv-ink)', display: 'inline-flex' }}><SparkGlyph /></span>
          )}
          {entry.kind === 'tool' && entry.pending ? (
            // The live activity line — one row per work phase, shimmering
            // through the latest tool with a running count. Not a pill per
            // call; the canvas side stays calm while the agent works.
            <motion.span
              animate={{ opacity: [0.45, 0.95, 0.45] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
              style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink)' }}
            >
              {entry.text}
              {(entry.count ?? 1) > 1 ? <span style={{ color: 'var(--cnv-ink-muted)' }}>{` · ${entry.count}`}</span> : null}
            </motion.span>
          ) : (
            <span style={{ fontSize: 10.5, fontWeight: 300, color: entry.pending || entry.kind === 'tool' ? 'var(--cnv-ink-muted)' : 'var(--cnv-ink)' }}>{entry.text}</span>
          )}
        </div>
      ) : null}
      {entry.role === 'result' ? (
        entry.kind === 'files' ? (
          <FilesResult title={entry.title} files={entry.files ?? []} adds={entry.adds} dels={entry.dels} onReview={() => {}} onUndo={() => {}} />
        ) : entry.kind === 'pr' ? (
          <PrResult title={entry.title} number={entry.prNumber} repo={entry.repo} state={entry.prState} adds={entry.adds} dels={entry.dels} checks={entry.checks} onOpen={() => {}} />
        ) : entry.kind === 'screenshot' ? (
          <ScreenshotResult title={entry.title} body={entry.body} src={entry.src} onOpen={() => {}} />
        ) : (
          // generic — leading tile, title + meta, open arrow (flows on the glass).
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, paddingTop: 2, paddingBottom: 2 }}>
            <span
              aria-hidden
              style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--cnv-tint)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--cnv-ink-muted)' }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
              </svg>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--cnv-ink)' }}>
                {entry.title}
              </span>
              {entry.meta ? <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.meta}</span> : null}
            </span>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
              <path d="M7 17 17 7" /><path d="M7 7h10v10" />
            </svg>
          </div>
        )
      ) : null}
      {entry.role === 'text' ? (
        // Borderless prose — the assistant's turn flows on the glass, no boxed
        // card (Q's reference: smooth, no extra lines). revealedText paces the
        // reveal while live (matches the desktop chat); settles to full on done.
        <CanvasMarkdown text={revealedText} />
      ) : null}
      {entry.role === 'playback' ? (
        // Pops up at the end of a turn — play back the full answer aloud.
        <TurnPlaybackBar text={entry.text} messageId={String(entry.id)} />
      ) : null}
    </motion.div>
  );
}

/** Inline markdown — bold / italic / code / links — at the chat's type scale.
 *  Canvas-token styled (not the dashboard's --t-* tokens). Partial spans mid
 *  stream (e.g. an unclosed `**`) stay literal until their closer arrives. */
function cnvInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const key = `${keyBase}:${i++}`;
    if (value.startsWith('**')) {
      nodes.push(<strong key={key} style={{ fontWeight: 500, color: 'var(--cnv-ink)' }}>{value.slice(2, -2)}</strong>);
    } else if (value.startsWith('*')) {
      nodes.push(<em key={key}>{value.slice(1, -1)}</em>);
    } else if (value.startsWith('`')) {
      nodes.push(
        <code key={key} style={{ fontFamily: MONO, fontSize: '0.92em', background: 'var(--cnv-tint)', borderRadius: 5, paddingTop: 1, paddingBottom: 1, paddingLeft: 4, paddingRight: 4 }}>
          {value.slice(1, -1)}
        </code>,
      );
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      nodes.push(
        <a key={key} href={link?.[2] ?? '#'} target="_blank" rel="noreferrer" style={{ color: 'var(--cnv-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {link?.[1] ?? value}
        </a>,
      );
    }
    last = index + value.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const UL_RE = /^\s*[-*]\s+(.+)$/;
const OL_RE = /^\s*\d+\.\s+(.+)$/;

/** The orchestrator streams one `text` event per model content block — the
 *  prose around each tool call. ws-server forwards them verbatim and the page
 *  appends raw, so two abutting blocks read as "…screenshot.I'm on…": a
 *  sentence end with NO separating space before the next capital. The model
 *  never writes that inside a block (sentences always get a space), so it's a
 *  safe seam to break into paragraphs. Code is protected — never split inside
 *  ` ` / ``` spans (a `file.Name` there is real). The accumulation-seam fix
 *  (page.tsx appendAssistantDelta) is more precise; this render guard is the
 *  surface-side belt that keeps every transcript readable regardless. */
function splitRunOnSeams(text: string): string {
  return text
    .split(/(`{1,3}[^`]*`{1,3})/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([a-z0-9)\]"'])([.!?])([A-Z])/g, '$1$2\n\n$3')))
    .join('');
}

/** Block markdown — headings, lists, code fences, blockquotes, paragraphs —
 *  rendered as real elements so the orchestrator's answer reads as prose, not
 *  raw `**` and `#` source. Line-based, like the dashboard's MarkdownRender.
 *  Exported: the o8.md / file cards render their preview with it too. */
export function CanvasMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = splitRunOnSeams(text).split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code — consume through the closing ``` (or end of stream).
    if (/^```/.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`md-${key++}`} style={{ margin: 0, marginTop: 6, marginBottom: 6, overflowX: 'auto', background: 'var(--cnv-tint)', border: '1px solid var(--cnv-edge)', borderRadius: 9, paddingTop: 7, paddingBottom: 7, paddingLeft: 9, paddingRight: 9 }}>
          <code style={{ fontFamily: MONO, fontSize: 10.5, lineHeight: 1.5, color: 'var(--cnv-ink)', whiteSpace: 'pre' }}>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const size = level <= 1 ? 14 : level === 2 ? 13 : 12;
      blocks.push(
        <div key={`md-${key++}`} style={{ fontFamily: FONT, fontSize: size, fontWeight: 500, lineHeight: 1.3, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', marginTop: blocks.length === 0 ? 0 : 9, marginBottom: 3 }}>
          {cnvInline(heading[2] ?? '', `md-${key}`)}
        </div>,
      );
      i += 1;
      continue;
    }

    // List — group consecutive items into one <ul>/<ol>.
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && (UL_RE.test(lines[i] ?? '') || OL_RE.test(lines[i] ?? ''))) {
        const m = (lines[i] ?? '').match(UL_RE) ?? (lines[i] ?? '').match(OL_RE);
        items.push(<li key={`md-${key}-${i}`} style={{ marginBottom: 2 }}>{cnvInline(m?.[1] ?? '', `md-${key}-${i}`)}</li>);
        i += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={`md-${key++}`} style={{ margin: 0, marginTop: 3, marginBottom: 3, paddingLeft: 18 }}>{items}</List>);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      // Full-border box, never a Material borderLeft accent.
      blocks.push(
        <blockquote key={`md-${key++}`} style={{ margin: 0, marginTop: 5, marginBottom: 5, border: '1px solid var(--cnv-edge)', borderRadius: 9, background: 'var(--cnv-tint)', paddingTop: 5, paddingBottom: 5, paddingLeft: 9, paddingRight: 9, color: 'var(--cnv-ink-muted)' }}>
          {cnvInline(quote[1] ?? '', `md-${key}`)}
        </blockquote>,
      );
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      blocks.push(<div key={`md-${key++}`} style={{ height: 8 }} />);
      i += 1;
      continue;
    }

    blocks.push(<p key={`md-${key++}`} style={{ margin: 0, marginBottom: 7, lineHeight: 1.7 }}>{cnvInline(line, `md-${key}`)}</p>);
    i += 1;
  }

  return (
    <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.05px', color: 'var(--cnv-ink)', fontFamily: FONT }}>
      {blocks}
    </div>
  );
}
