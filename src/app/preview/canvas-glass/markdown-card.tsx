'use client';

/**
 * Render-on-screen (#1270) — a plain markdown explainer card on the canvas.
 *
 * The voice conductor (Symon) delegates deep work to the orchestrator; when the
 * answer is something to SHOW rather than say ("explain the Pythagorean theorem
 * on my screen"), the orchestrator calls the `o8_render` MCP tool → the
 * `render` canvas intent → this card blooms with a title + rendered markdown.
 *
 * Static: the content IS the card (no Q&A composer; persisted as a snapshot
 * identity so reloads keep rendered explainers). It shares the exact
 * GlassCardShell chrome every other canvas card uses; inline styles only,
 * themed via the host's --cnv-* vars.
 */

import { memo, useRef, type ReactNode } from 'react';
import { CHROME, FONT, scrollFadeY } from './ui';
import { InlineMarkdown } from './response-blocks';
import { GlassCardShell } from './card-shell';
import { useCanvasRenderProbe } from './perf/render-probe';
import { useScrollBlurFade } from './use-scroll-blur-fade';

export interface MarkdownCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  title: string;
  markdown: string;
}

export const MARKDOWN_MIN_W = 280;
export const MARKDOWN_MIN_H = 180;

/**
 * A lightweight, dependency-free block renderer — just enough markdown to make
 * an explainer read well on the canvas: headings, bullets, quotes, fenced code,
 * and paragraphs (inline **bold** / `code` via InlineMarkdown). Anything fancier
 * (tables, images) falls through to a plain paragraph.
 */
function MarkdownBody({ md }: { md: string }) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let key = 0;
  let codeBuffer: string[] | null = null;

  const pushCode = () => {
    if (codeBuffer) {
      blocks.push(
        <pre
          key={`b${key++}`}
          style={{
            margin: 0,
            padding: 10,
            borderRadius: 8,
            background: 'var(--cnv-tint)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: CHROME.bodySize,
            lineHeight: 1.5,
            color: 'var(--cnv-ink)',
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
          }}
        >
          {codeBuffer.join('\n')}
        </pre>,
      );
      codeBuffer = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith('```')) {
      if (codeBuffer) pushCode();
      else codeBuffer = [];
      continue;
    }
    if (codeBuffer) { codeBuffer.push(raw); continue; }

    if (!line.trim()) continue; // blank — the column gap carries the spacing

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const size = level === 1 ? 15.5 : level === 2 ? 13.5 : 12.5;
      blocks.push(
        <div
          key={`b${key++}`}
          style={{ fontSize: size, fontWeight: level === 1 ? 600 : 500, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', fontFamily: FONT, lineHeight: 1.35 }}
        >
          <InlineMarkdown text={heading[2]} />
        </div>,
      );
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <div key={`b${key++}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingLeft: 2 }}>
          <span aria-hidden style={{ flexShrink: 0, marginTop: 8, width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)' }} />
          <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.6, color: 'var(--cnv-ink)', fontFamily: FONT }}>
            <InlineMarkdown text={bullet[1]} />
          </span>
        </div>,
      );
      continue;
    }

    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push(
        <div key={`b${key++}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingLeft: 2 }}>
          <span style={{ flexShrink: 0, fontSize: CHROME.bodySize, fontWeight: 500, lineHeight: 1.6, color: 'var(--cnv-ink-muted)', fontFamily: FONT, fontVariantNumeric: 'tabular-nums' }}>{numbered[1]}.</span>
          <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.6, color: 'var(--cnv-ink)', fontFamily: FONT }}>
            <InlineMarkdown text={numbered[2]} />
          </span>
        </div>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <div
          key={`b${key++}`}
          style={{ paddingLeft: 10, borderLeft: '2px solid var(--cnv-edge)', fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.6, fontStyle: 'italic', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}
        >
          <InlineMarkdown text={quote[1]} />
        </div>,
      );
      continue;
    }

    blocks.push(
      <p key={`b${key++}`} style={{ margin: 0, fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.65, color: 'var(--cnv-ink)', fontFamily: FONT }}>
        <InlineMarkdown text={line} />
      </p>,
    );
  }
  pushCode();

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{blocks}</div>;
}

export const MarkdownGlassCard = memo(function MarkdownGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
}: {
  card: MarkdownCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}) {
  useCanvasRenderProbe('markdown', card.id);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useScrollBlurFade(scrollRef);

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={MARKDOWN_MIN_W}
      minH={MARKDOWN_MIN_H}
      title={card.title}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
      <div style={{ height: card.h, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div
          ref={scrollRef}
          style={{
            ...scrollFadeY,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            paddingTop: 4,
            paddingBottom: 14,
            paddingLeft: 16,
            paddingRight: 16,
            scrollbarWidth: 'none',
          } as React.CSSProperties}
        >
          <MarkdownBody md={card.markdown} />
        </div>
      </div>
    </GlassCardShell>
  );
});
