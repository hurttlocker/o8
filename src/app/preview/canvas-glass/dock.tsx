'use client';

/**
 * The docked orchestrator — the gabriell_lab companion borrow (#1232).
 * Opt-in: the conversation lives at the bottom composer until the operator
 * docks it. The dock floats directly on the canvas (no hard panel — it
 * fades in), shows every running orchestrator as a switcher row, and the
 * selected one's conversation streams in with soft fades: prompt bubble,
 * status line, result card, explanation text, numbered follow-ups.
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FONT, TONE_DOT, glass, type DockEntry, type OrchestratorLane } from './ui';

export const MOCK_LANES: OrchestratorLane[] = [
  { id: 'o8', label: 'o8 · main', repo: 'o8', tone: 'working' },
  { id: 'o8-site', label: 'o8-site · landing', repo: 'o8-site', tone: 'idle' },
  { id: 'eyes', label: 'eyes-web · prod', repo: 'mybeautifulwife', tone: 'waiting' },
];

const FOLLOW_UPS = [
  'Review the pending diff',
  'Dispatch a follow-up agent',
  'Open the packet terminal',
  'Ask the Brain about this lane',
];

export function OrchestratorDock({
  entries,
  activeLane,
  onSelectLane,
  onClose,
}: {
  entries: DockEntry[];
  activeLane: string;
  onSelectLane: (id: string) => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

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
        width: 304,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        zIndex: 43,
        fontFamily: FONT,
        // No panel — the dock fades into the canvas; a soft gradient only.
        background: 'linear-gradient(270deg, var(--cnv-bg-veil) 0%, transparent 100%)',
        paddingLeft: 10,
      }}
    >
      {/* Switcher — every running orchestrator, click to switch. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}>
            Orchestrators
          </span>
          <button
            type="button"
            aria-label="Undock orchestrator"
            onClick={onClose}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontSize: 11, fontFamily: FONT }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>
        {MOCK_LANES.map((lane) => {
          const active = lane.id === activeLane;
          return (
            <button
              key={lane.id}
              type="button"
              onClick={() => onSelectLane(lane.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 9,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: active ? 'var(--cnv-edge)' : 'transparent',
                ...(active ? { background: 'var(--cnv-tint)' } : { background: 'transparent' }),
                cursor: 'pointer',
                fontFamily: FONT,
              }}
            >
              <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_DOT[lane.tone], flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, fontWeight: active ? 400 : 300, color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)', letterSpacing: '-0.1px' }}>
                {lane.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Conversation — streams in, no container chrome. */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2, scrollbarWidth: 'none' } as React.CSSProperties}
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
    </motion.div>
  );
}

function DockEntryView({ entry }: { entry: DockEntry }) {
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
            maxWidth: 250,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 13,
            fontSize: 11.5,
            fontWeight: 300,
            lineHeight: 1.55,
            letterSpacing: '-0.1px',
            ...glass(true),
            boxShadow: 'none',
          }}
        >
          {entry.text}
        </div>
      ) : null}
      {entry.role === 'status' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {entry.pending ? (
            <motion.span
              aria-hidden
              animate={{ rotate: 360 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
              style={{ width: 9, height: 9, borderRadius: '50%', border: '1px solid transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)', flexShrink: 0 }}
            />
          ) : (
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_DOT.working, flexShrink: 0 }} />
          )}
          <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>{entry.text}</span>
        </div>
      ) : null}
      {entry.role === 'result' ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            paddingTop: 9,
            paddingBottom: 9,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 12,
            ...glass(),
            boxShadow: 'none',
          }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.title}
          </span>
          <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>{entry.meta}</span>
        </div>
      ) : null}
      {entry.role === 'text' ? <StreamedText text={entry.text} /> : null}
      {entry.role === 'followups' ? <FollowUps /> : null}
    </motion.div>
  );
}

/** Words fade in one by one — the smooth streaming feel from the reference. */
function StreamedText({ text }: { text: string }) {
  const words = text.split(' ');
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    if (visible >= words.length) return;
    const timer = setInterval(() => {
      setVisible((value) => Math.min(words.length, value + 1));
    }, 38);
    return () => clearInterval(timer);
  }, [visible, words.length]);
  return (
    <p style={{ margin: 0, fontSize: 11, fontWeight: 300, lineHeight: 1.65, letterSpacing: '-0.05px', color: 'var(--cnv-ink)' }}>
      {words.slice(0, visible).map((word, index) => (
        <motion.span key={index} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
          {word}{' '}
        </motion.span>
      ))}
    </p>
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
