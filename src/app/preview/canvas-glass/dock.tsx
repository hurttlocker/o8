'use client';

/**
 * The docked orchestrator — the gabriell_lab companion borrow (#1232).
 * Opt-in: the conversation lives at the bottom composer until the operator
 * docks it. The dock floats directly on the canvas (no hard panel — it
 * fades in), shows every running orchestrator as a switcher row, and the
 * selected one's conversation streams in with soft fades: prompt bubble,
 * status line, result card, explanation text, numbered follow-ups.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FONT, TONE_DOT, glass, type DockEntry, type OrchestratorLane } from './ui';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

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
  onSelectLane,
  onClose,
}: {
  lanes: OrchestratorLane[];
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
        {lanes.map((lane) => {
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
      {entry.role === 'text' ? <CanvasMarkdown text={entry.text} /> : null}
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
 *  raw `**` and `#` source. Line-based, like the dashboard's MarkdownRender. */
function CanvasMarkdown({ text }: { text: string }) {
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
      blocks.push(<div key={`md-${key++}`} style={{ height: 6 }} />);
      i += 1;
      continue;
    }

    blocks.push(<p key={`md-${key++}`} style={{ margin: 0, marginBottom: 5, lineHeight: 1.65 }}>{cnvInline(line, `md-${key}`)}</p>);
    i += 1;
  }

  return (
    <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.05px', color: 'var(--cnv-ink)', fontFamily: FONT }}>
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
