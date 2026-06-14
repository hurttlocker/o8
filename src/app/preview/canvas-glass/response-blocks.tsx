'use client';

/**
 * Shared response blocks — the agent-card bench vocabulary, extracted so the
 * dock, the floating chat-cards, the Brain (Cortex) tab, AND the bench all
 * render from ONE source (no divergence). All borderless, all --cnv-* tokens.
 *
 * The blocks: a staged reasoning timeline lives in reasoning.tsx (it's driven
 * by real thinking deltas). Here are the RESULT blocks (files / PR / screenshot)
 * and the Cortex citation block — the rich turn artifacts the reference shows.
 */

import type { ReactNode } from 'react';
import { FONT } from './ui';

/** Diff stats — semantic +adds (green) / −dels (red). */
export function DiffStat({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 400, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.1px', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#3fb950' }}>{`+${adds}`}</span>
      <span>{'  '}</span>
      <span style={{ color: '#f85149' }}>{`−${dels}`}</span>
    </span>
  );
}

/** Borderless text action (Review / Undo / Open) — a soft tint chip. */
export function ActionChip({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onClick?.(); }}
      style={{ borderWidth: 0, background: 'var(--cnv-tint)', borderRadius: 7, paddingTop: 3, paddingBottom: 3, paddingLeft: 9, paddingRight: 9, fontSize: 11, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', cursor: 'pointer', fontFamily: FONT }}
    >
      {label}
    </button>
  );
}

/** A result row — borderless at rest, a faint tint on hover to afford the
 *  click (open the PR, the diff, the file set). Leading visual + body. */
export function ResultRow({ children, onOpen }: { children: ReactNode; onOpen?: () => void }) {
  return (
    <div
      onClick={onOpen}
      style={{ display: 'flex', gap: 13, alignItems: 'flex-start', borderRadius: 12, paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8, marginLeft: -8, marginRight: -8, cursor: onOpen ? 'pointer' : 'default', transition: 'background 140ms ease' }}
      onMouseEnter={(event) => { if (onOpen) event.currentTarget.style.background = 'var(--cnv-tint)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </div>
  );
}

/** Leading icon tile — the borderless analog of the screenshot thumbnail for
 *  icon-style results (edits, PRs). */
export function ResultTile({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--cnv-tint)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: tone ?? 'var(--cnv-ink-muted)' }}>
      {children}
    </span>
  );
}

/** A faux app screenshot — fixed dark UI (it depicts an image, not a theme
 *  surface). Used when a result has no real capture src yet. */
export function ScreenshotThumb({ src }: { src?: string }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" style={{ width: 92, height: 66, borderRadius: 11, objectFit: 'cover', flexShrink: 0 }} />
    );
  }
  return (
    <div style={{ width: 92, height: 66, borderRadius: 11, overflow: 'hidden', flexShrink: 0, background: 'linear-gradient(160deg, #2b303b 0%, #14171d 100%)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 13, display: 'flex', alignItems: 'center', gap: 3, paddingLeft: 6, background: 'rgba(255,255,255,0.05)' }}>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.28)' }} />
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.18)' }} />
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.12)' }} />
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 5, paddingTop: 6, paddingBottom: 6, paddingLeft: 6, paddingRight: 8 }}>
        <div style={{ width: 16, background: 'rgba(255,255,255,0.06)', borderRadius: 3, flexShrink: 0 }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 }}>
          <div style={{ height: 5, width: '64%', background: 'rgba(255,255,255,0.12)', borderRadius: 2 }} />
          <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }} />
          <div style={{ height: 5, width: '84%', background: 'rgba(255,255,255,0.06)', borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}

/** A captured-screenshot result. No title → image-led: just show the capture
 *  (Q's call — the orchestrator names it in its reply, the card only needs to
 *  show what it grabbed). With a title it keeps the labelled thumb+text row. */
export function ScreenshotResult({ title, body, src, onOpen }: { title?: string; body?: string; src?: string; onOpen?: () => void }) {
  if (!title) {
    return (
      <div
        onClick={onOpen}
        style={{ width: '100%', maxHeight: 260, overflow: 'hidden', borderRadius: 12, border: '1px solid var(--cnv-edge)', cursor: onOpen ? 'pointer' : 'default' }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="screen capture" style={{ display: 'block', width: '100%', height: 'auto' }} />
        ) : (
          <ScreenshotThumb src={src} />
        )}
      </div>
    );
  }
  return (
    <ResultRow onOpen={onOpen}>
      <ScreenshotThumb src={src} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', lineHeight: 1.3 }}>{title}</span>
        {body ? (
          <span style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--cnv-ink-muted)' }}>{body}</span>
        ) : null}
      </div>
    </ResultRow>
  );
}

/** "Edited N files" result — icon tile, title, the file set, stats + actions. */
export function FilesResult({ title, files, adds, dels, onReview, onUndo }: {
  title: string;
  files: string[];
  adds?: number;
  dels?: number;
  onReview?: () => void;
  onUndo?: () => void;
}) {
  return (
    <ResultRow onOpen={onReview}>
      <ResultTile>
        <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="m10 13-2 2 2 2" /><path d="m14 13 2 2-2 2" />
        </svg>
      </ResultTile>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)' }}>{title}</span>
        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {files.join(' · ')}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 2 }}>
          {typeof adds === 'number' && typeof dels === 'number' ? <DiffStat adds={adds} dels={dels} /> : null}
          <span style={{ flex: 1 }} />
          {onReview ? <ActionChip label="Review" onClick={onReview} /> : null}
          {onUndo ? <ActionChip label="Undo" onClick={onUndo} /> : null}
        </div>
      </div>
    </ResultRow>
  );
}

/** PR result — merged-purple icon tile, title, number/repo/status, stats + checks. */
export function PrResult({ title, number, repo, state, adds, dels, checks, onOpen }: {
  title: string;
  number?: number;
  repo?: string;
  state?: string;
  adds?: number;
  dels?: number;
  checks?: string;
  onOpen?: () => void;
}) {
  const merged = (state ?? '').toLowerCase() === 'merged';
  const tone = merged ? '#a371f7' : '#3fb950';
  return (
    <ResultRow onOpen={onOpen}>
      <ResultTile tone={tone}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </ResultTile>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', lineHeight: 1.3 }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>
          {[number ? `#${number}` : null, repo].filter(Boolean).join(' · ')}
          {state ? <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: tone, flexShrink: 0 }} /> : null}
          {state}
        </span>
        {(typeof adds === 'number' && typeof dels === 'number') || checks ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 2 }}>
            {typeof adds === 'number' && typeof dels === 'number' ? <DiffStat adds={adds} dels={dels} /> : null}
            {checks ? (
              <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>
                <span style={{ color: '#3fb950' }}>✓</span>{` ${checks}`}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </ResultRow>
  );
}

/** Smooth citations — borderless titled pills (the titled-sources contract),
 *  a muted kind dot per source, then the 'N cited · M considered' caption. */
export function Citations({ sources, cited, considered }: { sources: Array<{ kind?: string; title: string }>; cited: number; considered: number }) {
  if (!sources.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
      <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', opacity: 0.85, fontFamily: FONT }}>
        Sources
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sources.map((source, index) => (
          <span
            key={`${source.title}-${index}`}
            title={source.kind ? `${source.title} · ${source.kind}` : source.title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              maxWidth: 220,
              background: 'var(--cnv-tint)',
              borderRadius: 9,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 9,
              paddingRight: 11,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--cnv-ink)',
              fontFamily: FONT,
            }}
          >
            <span aria-hidden style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.title}</span>
          </span>
        ))}
      </div>
      <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', opacity: 0.85, fontFamily: FONT }}>
        {`${cited} cited · ${considered} considered`}
      </span>
    </div>
  );
}

/** Minimal inline markdown — **bold** and `code` only, at the host's type
 *  scale. Used for the Brain answer (it can't import the dock's CanvasMarkdown
 *  without a cycle, and only needs these two). */
export function InlineMarkdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const key = `im${i++}`;
    if (value.startsWith('**')) {
      nodes.push(<strong key={key} style={{ fontWeight: 500, color: 'var(--cnv-ink)' }}>{value.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code key={key} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em', background: 'var(--cnv-tint)', borderRadius: 5, paddingTop: 1, paddingBottom: 1, paddingLeft: 4, paddingRight: 4 }}>
          {value.slice(1, -1)}
        </code>,
      );
    }
    last = index + value.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

/** The retrieval beat — "Reading N sources…" while live, settling to a
 *  "Read N sources" count once the answer lands. Bench's uppercase label. */
export function SourcesLine({ count, pending }: { count: number; pending?: boolean }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
      {pending ? `Reading ${count} sources…` : `Read ${count} sources`}
    </span>
  );
}
