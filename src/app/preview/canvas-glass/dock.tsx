'use client';

/**
 * The docked orchestrator — the gabriell_lab companion borrow (#1232).
 * Opt-in: the conversation lives at the bottom composer until the operator
 * docks it. The dock floats directly on the canvas (no hard panel — it
 * fades in), shows every running orchestrator as a switcher row, and the
 * selected one's conversation streams in with soft fades: prompt bubble,
 * status line, result card, explanation text, numbered follow-ups.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { FONT, TONE_DOT, glass, glassPop, type DockEntry, type OrchestratorLane } from './ui';
import { ReasoningView } from './reasoning';
import { BrainConversation } from './brain-card';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

/** The reference's spark — marks a settled turn-status line. */
function SparkGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ flexShrink: 0 }}>
      <path d="M12 3l1.9 6.4a1 1 0 0 0 .7.7L21 12l-6.4 1.9a1 1 0 0 0-.7.7L12 21l-1.9-6.4a1 1 0 0 0-.7-.7L3 12l6.4-1.9a1 1 0 0 0 .7-.7z" />
    </svg>
  );
}

const FOLLOW_UPS = [
  'Review the pending diff',
  'Dispatch a follow-up agent',
  'Open the packet terminal',
  'Ask the Brain about this lane',
];

export function OrchestratorDock({
  lanes,
  entries,
  activeLane,
  activeLabel,
  activeTone,
  onSelectLane,
  onSend,
  busy,
  onClose,
}: {
  /** Lanes with a running conversation — the dropdown's contents. */
  lanes: OrchestratorLane[];
  entries: DockEntry[];
  activeLane: string;
  activeLabel: string;
  activeTone: OrchestratorLane['tone'];
  onSelectLane: (id: string) => void;
  /** Send a reply from the dock's own composer. */
  onSend: (message: string) => void;
  busy: boolean;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<'orchestrator' | 'cortex'>('orchestrator');
  const [laneMenuOpen, setLaneMenuOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const laneMenuRef = useRef<HTMLDivElement | null>(null);
  const laneButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

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
      style={{
        position: 'absolute',
        top: 74,
        right: 24,
        bottom: 96,
        width: 400,
        zIndex: 43,
        fontFamily: FONT,
        // Lisse's wrapper is an unstyled block — grid stretches it to fill so
        // the panel runs top-to-bottom (height 100% chain).
        display: 'grid',
      }}
    >
      {/* No hard panel — the dock FADES into the canvas on its left; the solid
          right side gets the Apple-smooth per-corner clip. The dock is PINNED
          (not a floating card — that role belongs to the chat-card modal), so
          there's no drag/resize and no per-frame backdrop re-sample to flicker. */}
      <SmoothCorners
        corners={{ topLeft: 0, bottomLeft: 0, topRight: 18, bottomRight: 18 }}
        autoEffects={false}
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
          background: 'linear-gradient(270deg, var(--cnv-dock-veil) 0%, transparent 100%)',
        } as React.CSSProperties}
      >
        {/* Tabs — the orchestrator NEVER rides without its Cortex side; both
            share the one pane, spread + underlined like the reference. The ✕
            undocks (the conversation returns to the composer below). The dock
            is pinned, so this strip is the panel's only chrome — no drag bar. */}
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 18, paddingRight: 10, paddingTop: 11, borderBottom: '1px solid var(--cnv-edge)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1 }}>
            <DockTab label="Orchestrator" active={activeTab === 'orchestrator'} onClick={() => setActiveTab('orchestrator')} />
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
            {/* Header — the active orchestrator + a dropdown of what's running. */}
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
                    {otherLanes.length === 0 ? (
                      <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }}>
                        Nothing else running — scope a repo from the composer.
                      </span>
                    ) : (
                      otherLanes.map((lane) => (
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
                      ))
                    )}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            {/* Conversation. */}
            <div
              ref={scrollRef}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 14, paddingRight: 14, paddingBottom: 14, scrollbarWidth: 'none' } as React.CSSProperties}
              onClick={() => {
                if (laneMenuOpen) setLaneMenuOpen(false);
              }}
            >
              <AnimatePresence initial={false}>
                {entries.map((entry) => (
                  <DockEntryView key={entry.id} entry={entry} />
                ))}
              </AnimatePresence>
              {entries.length === 0 ? (
                <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.6 }}>
                  No conversation on this lane yet — message the orchestrator below.
                </span>
              ) : null}
            </div>

            {/* Reply right here — the card owns its own composer. */}
            <div style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 12, paddingTop: 4, flexShrink: 0 }}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    const prompt = draft.trim();
                    if (!prompt || busy) return;
                    onSend(prompt);
                    setDraft('');
                  }
                }}
                placeholder={busy ? 'Working — interrupt from the main composer' : `Reply to ${activeLabel}`}
                aria-label="Reply to the orchestrator"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  paddingTop: 9,
                  paddingBottom: 9,
                  paddingLeft: 13,
                  paddingRight: 13,
                  borderRadius: 11,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--cnv-edge)',
                  background: 'var(--cnv-tint)',
                  color: 'var(--cnv-ink)',
                  fontSize: 12,
                  fontWeight: 300,
                  fontFamily: FONT,
                  outline: 'none',
                }}
              />
            </div>
          </>
        )}
      </SmoothCorners>
    </motion.div>
  );
}

/** One pane-header tab — Orchestrator | Cortex, the reference's two-tab strip:
 *  a weight + ink shift plus an underline indicator that sits on the divider.
 *  Exported: the chat-card orchestrator modal renders the same strip. */
export function DockTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        borderWidth: 0,
        background: 'transparent',
        paddingTop: 0,
        paddingBottom: 9,
        paddingLeft: 2,
        paddingRight: 2,
        cursor: 'pointer',
        fontFamily: FONT,
        fontSize: 12.5,
        fontWeight: active ? 500 : 400,
        letterSpacing: '-0.1px',
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        transition: 'color 140ms ease',
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      {label}
      {/* Active indicator — a 2px ink bar flush on the strip's divider. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: -1,
          height: 2,
          borderRadius: 2,
          background: active ? 'var(--cnv-ink)' : 'transparent',
          transition: 'background 160ms ease',
        }}
      />
    </button>
  );
}

/** Shared by the dock AND the floating chat cards — one entry vocabulary. */
export function DockEntryView({ entry, suppressBlur = false }: { entry: DockEntry; suppressBlur?: boolean }) {
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
            maxWidth: 300,
            display: 'flex',
            flexDirection: 'column',
            gap: entry.images?.length ? 7 : 0,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 13,
            fontSize: 11.5,
            fontWeight: 300,
            lineHeight: 1.55,
            letterSpacing: '-0.1px',
            ...glass(true, suppressBlur),
            boxShadow: 'none',
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
        // The reference's response card: leading tile, title + meta, open arrow.
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 9,
            paddingRight: 10,
            borderRadius: 12,
            ...glass(false, suppressBlur),
            boxShadow: 'none',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'var(--cnv-tint)',
              border: '1px solid var(--cnv-edge)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: 'var(--cnv-ink-muted)',
            }}
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
            </svg>
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--cnv-ink)' }}>
              {entry.title}
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.meta}</span>
          </span>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
            <path d="M7 17 17 7" /><path d="M7 7h10v10" />
          </svg>
        </div>
      ) : null}
      {entry.role === 'text' ? (
        // Each assistant turn reads as its own quiet card — a hairline
        // pane instead of a wall of flowing text (Q: "do we have cards
        // we can use for turns?").
        <div
          style={{
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--cnv-edge)',
            background: 'var(--cnv-tint)',
            paddingTop: 10,
            paddingBottom: 11,
            paddingLeft: 13,
            paddingRight: 13,
          }}
        >
          <CanvasMarkdown text={entry.text} />
        </div>
      ) : null}
      {entry.role === 'followups' ? <FollowUps /> : null}
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

/** Block markdown — headings, lists, code fences, blockquotes, paragraphs —
 *  rendered as real elements so the orchestrator's answer reads as prose, not
 *  raw `**` and `#` source. Line-based, like the dashboard's MarkdownRender.
 *  Exported: the o8.md / file cards render their preview with it too. */
export function CanvasMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
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

function FollowUps() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', marginBottom: 2 }}>
        Suggested follow-ups
      </span>
      {FOLLOW_UPS.map((label, index) => (
        <motion.button
          key={label}
          type="button"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.12 * index, ease: 'easeOut' }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            paddingTop: 7,
            paddingBottom: 7,
            paddingLeft: 11,
            paddingRight: 9,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--cnv-edge)',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', textAlign: 'left' }}>{label}</span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 400,
              color: 'var(--cnv-ink-muted)',
              width: 14,
              height: 14,
              borderRadius: 4,
              border: '1px solid var(--cnv-edge)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {index + 1}
          </span>
        </motion.button>
      ))}
    </div>
  );
}
