'use client';

/**
 * DockAskPanel — the grown Ask answer panel inside the screen dock (voice P4
 * phase C3). Rendered by DockNotchSurface when the dock is in `ask` mode with a
 * thread to show: a header (Ask · close) + a scrollable Q/o8 conversation thread
 * with a lightweight markdown renderer + per-answer copy button.
 *
 * Port of Symon's NotchSurface answer panel. Inline styles only; the literal
 * rgba/gradient values mirror Symon's `--symon-*` palette verbatim — the same
 * documented exception DockNotchSurface uses, so the panel reads as the SAME
 * material as the listening capsule it grew from.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export type AskTurn = { role: 'user' | 'assistant'; text: string };

// ── Symon palette (literal) ──
const LABEL_STYLE: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 260,
  letterSpacing: '-0.4px',
  textTransform: 'uppercase',
  color: 'rgba(255, 255, 255, 0.55)',
  marginBottom: 4,
};
const PROMPT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.5,
  color: 'rgba(255, 255, 255, 0.78)',
  whiteSpace: 'pre-wrap',
};
const ANSWER_STYLE: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.5,
  color: '#f4f5f7',
};
const LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  paddingLeft: 20,
  margin: '4px 0 8px',
};
const LI_STYLE: CSSProperties = { ...ANSWER_STYLE, margin: 0, paddingLeft: 2 };
const INLINE_CODE_STYLE: CSSProperties = {
  paddingTop: 1,
  paddingBottom: 1,
  paddingLeft: 5,
  paddingRight: 5,
  borderRadius: 5,
  background: 'rgba(255, 255, 255, 0.1)',
  color: '#f4f5f7',
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  fontSize: '0.9em',
};

// ── Inline markdown — `code` + **bold**, single pass ──
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(<code key={key++} style={INLINE_CODE_STYLE}>{m[1].slice(1, -1)}</code>);
    } else if (m[2]) {
      nodes.push(<strong key={key++} style={{ fontWeight: 600 }}>{m[2].slice(2, -2)}</strong>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ── Block markdown — paragraphs, unordered + ordered lists ──
function AskMarkdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l))) {
          return (
            <ul key={bi} style={LIST_STYLE}>
              {lines.map((l, li) => (
                <li key={li} style={LI_STYLE}>{parseInline(l.replace(/^[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        if (lines.length > 0 && lines.every((l) => /^\d+\.\s+/.test(l))) {
          return (
            <ol key={bi} style={LIST_STYLE}>
              {lines.map((l, li) => (
                <li key={li} style={LI_STYLE}>{parseInline(l.replace(/^\d+\.\s+/, ''))}</li>
              ))}
            </ol>
          );
        }
        return <p key={bi} style={ANSWER_STYLE}>{parseInline(block.replace(/\n/g, ' '))}</p>;
      })}
    </>
  );
}

// ── A single conversation turn ──
function AskTurnRow({
  turn,
  index,
  copied,
  onCopy,
}: {
  turn: AskTurn;
  index: number;
  copied: boolean;
  onCopy: (index: number, text: string) => void;
}) {
  const [hover, setHover] = useState(false);

  if (turn.role === 'user') {
    return (
      <div style={{ margin: '12px 0', position: 'relative' }}>
        <div style={LABEL_STYLE}>You</div>
        <p style={PROMPT_STYLE}>{turn.text}</p>
      </div>
    );
  }

  const copyVisible = copied || hover;
  return (
    <div
      style={{ margin: '12px 0', position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={LABEL_STYLE}>Symon</div>
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy answer'}
        onClick={() => onCopy(index, turn.text)}
        style={{
          position: 'absolute',
          top: -2,
          right: 0,
          fontSize: 9.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          color: copied ? '#7fe0b0' : 'rgba(255, 255, 255, 0.55)',
          background: 'rgba(255, 255, 255, 0.06)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: 6,
          paddingTop: 2,
          paddingBottom: 2,
          paddingLeft: 7,
          paddingRight: 7,
          cursor: 'pointer',
          opacity: copyVisible ? 1 : 0,
          transition: 'opacity 0.16s ease, background 0.16s ease',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <AskMarkdown text={turn.text} />
    </div>
  );
}

interface DockAskPanelProps {
  thread: AskTurn[];
  onClose: () => void;
}

/** The 420×380 answer panel body — header + scrollable thread. */
export function DockAskPanel({ thread, onClose }: DockAskPanelProps) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Auto-scroll to the newest turn.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length]);

  const handleCopy = (index: number, text: string) => {
    if (!text.trim()) return;
    void navigator.clipboard?.writeText(text).catch(() => { /* noop */ });
    setCopiedIdx(index);
    setTimeout(() => setCopiedIdx((c) => (c === index ? null : c)), 1400);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flex: 'none',
          paddingTop: 9,
          paddingRight: 12,
          paddingBottom: 5,
          paddingLeft: 16,
        }}
      >
        {/* Symon mark — the voice agent answering */}
        <span
          aria-hidden
          style={{
            width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
            background: 'radial-gradient(circle at 64% 28%, rgba(255,255,255,0.9), transparent 30%), conic-gradient(from 210deg at 50% 50%, #88d1f1, #b1b4e5 32%, #f5b8c4 62%, #f4c977 82%, #88d1f1)',
            boxShadow: '0 0 8px rgba(136,209,241,0.45)',
          }}
        />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 300,
            letterSpacing: '0.04em',
            color: 'rgba(255, 255, 255, 0.72)',
            textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
          }}
        >
          Symon
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={() => onClose()}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 7,
            border: 'none',
            background: 'transparent',
            color: 'rgba(255, 255, 255, 0.55)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Thread */}
      <div
        ref={threadRef}
        className="ndock-ask-thread"
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          paddingTop: 2,
          paddingRight: 18,
          paddingBottom: 14,
          paddingLeft: 18,
        }}
      >
        {thread.map((turn, i) => (
          <AskTurnRow key={i} turn={turn} index={i} copied={copiedIdx === i} onCopy={handleCopy} />
        ))}
        <style>{'.ndock-ask-thread::-webkit-scrollbar{width:0;height:0}'}</style>
      </div>
    </div>
  );
}
