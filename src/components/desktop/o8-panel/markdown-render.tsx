'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildPreviewSrcdoc, type HtmlStylePalette } from '@/lib/spec/html-style-presets';
import { sanitizeAgentHtml } from '@/lib/render/sanitize-html';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const subscribeToMountedState = () => () => {};
const getMountedSnapshot = () => true;
const getServerMountedSnapshot = () => false;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (value.startsWith('**')) {
      nodes.push(<strong key={index} style={{ fontWeight: 500 }}>{value.slice(2, -2)}</strong>);
    } else if (value.startsWith('*')) {
      nodes.push(<em key={index}>{value.slice(1, -1)}</em>);
    } else if (value.startsWith('`')) {
      nodes.push(<code key={index} style={{ fontFamily: MONO_FONT, fontSize: '0.92em', background: 'var(--t-input-bg)', borderRadius: 8, paddingTop: 1, paddingRight: 4, paddingBottom: 1, paddingLeft: 4 }}>{value.slice(1, -1)}</code>);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      nodes.push(<a key={index} href={link?.[2] ?? '#'} target="_blank" rel="noreferrer" style={{ color: 'var(--t-accent)', textDecoration: 'none' }}>{link?.[1] ?? value}</a>);
    }
    last = index + value.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Slice a content string into a stream of typed segments. We pre-extract
// fenced ```html blocks, fenced ```other blocks, inline <svg>, and inline
// <iframe> regions so the line-based markdown pass below doesn't have to
// reason about multi-line HTML/SVG. Order is preserved.
type Segment =
  | { kind: 'md'; text: string }
  | { kind: 'fenced-html'; code: string }
  | { kind: 'fenced-code'; lang: string | null; code: string }
  | { kind: 'svg'; html: string }
  | { kind: 'iframe'; html: string };

const FENCED_RE = /^```([^\n]*)\n([\s\S]*?)\n```/m;
const SVG_RE = /<svg\b[\s\S]*?<\/svg>/i;
const IFRAME_RE = /<iframe\b[\s\S]*?(?:<\/iframe>|\/>)/i;

type MatchHit = { start: number; end: number; build: () => Segment };

function nextMatch(text: string): MatchHit | null {
  const candidates: MatchHit[] = [];
  const fenced = FENCED_RE.exec(text);
  if (fenced) {
    const idx = fenced.index;
    const lang = (fenced[1] ?? '').trim().toLowerCase() || null;
    const code = fenced[2] ?? '';
    const length = fenced[0].length;
    candidates.push({
      start: idx,
      end: idx + length,
      build: (): Segment => lang === 'html'
        ? { kind: 'fenced-html', code }
        : { kind: 'fenced-code', lang, code },
    });
  }
  const svg = SVG_RE.exec(text);
  if (svg) {
    const idx = svg.index;
    candidates.push({ start: idx, end: idx + svg[0].length, build: (): Segment => ({ kind: 'svg', html: svg[0] }) });
  }
  const iframe = IFRAME_RE.exec(text);
  if (iframe) {
    const idx = iframe.index;
    candidates.push({ start: idx, end: idx + iframe[0].length, build: (): Segment => ({ kind: 'iframe', html: iframe[0] }) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0] ?? null;
}

function segmentize(content: string): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const slice = content.slice(cursor);
    const m = nextMatch(slice);
    if (!m) {
      out.push({ kind: 'md', text: slice });
      break;
    }
    if (m.start > 0) out.push({ kind: 'md', text: slice.slice(0, m.start) });
    out.push(m.build());
    cursor += m.end;
  }
  return out;
}

function renderMarkdownLines(text: string, keyPrefix: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const k = `${keyPrefix}:${index}`;
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const size = level === 1 ? 22 : level === 2 ? 18 : level === 3 ? 15 : 13;
      const Tag = `h${Math.min(level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={k} style={{ marginTop: level === 1 ? 4 : 18, marginBottom: 8, fontFamily: UI_FONT, fontSize: size, lineHeight: 1.25, color: 'var(--t-text)', fontWeight: 400, letterSpacing: '-0.2px' }}>{inline(heading[2] ?? '')}</Tag>);
      return;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const List = unordered ? 'ul' : 'ol';
      blocks.push(<List key={k} style={{ marginTop: 4, marginBottom: 4, paddingLeft: 22, color: 'var(--t-text)' }}><li style={{ marginBottom: 4 }}>{inline((unordered ?? ordered)?.[1] ?? '')}</li></List>);
      return;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(<blockquote key={k} style={{ marginTop: 8, marginBottom: 8, marginLeft: 0, marginRight: 0, border: '1px solid var(--t-divider-subtle)', borderRadius: 12, background: 'var(--t-bg-subtle)', paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, color: 'var(--t-text-muted)' }}>{inline(quote[1] ?? '')}</blockquote>);
      return;
    }

    blocks.push(line.trim() ? <p key={k} style={{ marginTop: 0, marginBottom: 10 }}>{inline(line)}</p> : <div key={k} style={{ height: 8 }} />);
  });
  return blocks;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre style={{ marginTop: 10, marginBottom: 10, overflowX: 'auto', background: 'var(--t-input-bg)', border: '1px solid var(--t-divider-subtle)', borderRadius: 14, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12 }}>
      <code style={{ fontFamily: MONO_FONT, fontSize: 12, color: 'var(--t-text)' }}>{code}</code>
    </pre>
  );
}

function ViewButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        // Flat per DESIGN.md §06.7 — no always-on border. Active fills with
        // var(--t-input-bg); inactive is transparent → var(--t-hover) on
        // hover. Geometry matched: 26h / 7r.
        border: 'none',
        borderRadius: 7,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: UI_FONT,
        fontSize: 11,
        fontWeight: 350,
        letterSpacing: '-0.1px',
        minHeight: 26,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

function FencedHtmlBlock({ code, theme }: { code: string; theme: HtmlStylePalette }) {
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [height, setHeight] = useState<number>(120);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const srcdoc = useMemo(() => buildPreviewSrcdoc(code, { theme }), [code, theme]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'o8-html-preview-height') return;
      // Multiple iframes can be on the page; only respond when the source
      // matches our iframe's contentWindow.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const next = Math.max(60, Math.min(2400, Number(data.height) || 0));
      if (Number.isFinite(next) && next > 0) setHeight(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div style={{ marginTop: 12, marginBottom: 12, border: '1px solid var(--t-divider-subtle)', borderRadius: 14, overflow: 'hidden', background: 'var(--t-bg-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 36, paddingLeft: 10, paddingRight: 10, borderBottom: '1px solid var(--t-divider-subtle)', fontFamily: UI_FONT }}>
        <span style={{ flex: 1, color: 'var(--t-text-faint)', fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase' }}>html</span>
        <ViewButton active={view === 'preview'} label="Preview" onClick={() => setView('preview')} />
        <ViewButton active={view === 'source'} label="Source" onClick={() => setView('source')} />
      </div>
      {view === 'preview' ? (
        <iframe
          ref={iframeRef}
          title="HTML block preview"
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          style={{ display: 'block', width: '100%', height, border: 'none', background: 'transparent' }}
        />
      ) : (
        <CodeBlock code={code} />
      )}
    </div>
  );
}

function InlineSvg({ html }: { html: string }) {
  // Agent-authored SVG is UNTRUSTED — sanitize before insertion (DOMPurify
  // strips <script>, on* handlers, SMIL onbegin/onend, <foreignObject>). The
  // old "SVG is safe to drop in directly" assumption was a same-origin XSS
  // (SECURITY_AUDIT_2026-07-02 §CRIT-2). Gate behind `mounted` so the server
  // render (empty) matches the first client render — no hydration mismatch.
  const mounted = useSyncExternalStore(
    subscribeToMountedState,
    getMountedSnapshot,
    getServerMountedSnapshot,
  );
  const safe = useMemo(() => (mounted ? sanitizeAgentHtml(html) : ''), [mounted, html]);
  return (
    <div style={{ marginTop: 10, marginBottom: 10 }} dangerouslySetInnerHTML={{ __html: safe }} />
  );
}

function PassthroughIframe({ html }: { html: string }) {
  // Inline <iframe> in agent/spec markdown is NOT rendered as a live frame — an
  // agent-controlled iframe (whose sandbox it sets itself) is a same-origin XSS
  // (§CRIT-2). The sanitizer strips the <iframe> entirely; use a fenced ```html
  // block (FencedHtmlBlock — fixed sandbox + network-blocking CSP) for
  // intentional HTML preview.
  const mounted = useSyncExternalStore(
    subscribeToMountedState,
    getMountedSnapshot,
    getServerMountedSnapshot,
  );
  const safe = useMemo(() => (mounted ? sanitizeAgentHtml(html) : ''), [mounted, html]);
  if (!safe) return null;
  return (
    <div style={{ marginTop: 10, marginBottom: 10 }} dangerouslySetInnerHTML={{ __html: safe }} />
  );
}

export function MarkdownRender({ content }: { content: string }) {
  const { paletteId } = useTheme();
  const theme: HtmlStylePalette = paletteId === 'light' ? 'light' : 'midnight';
  const segments = useMemo(() => segmentize(content), [content]);

  return (
    <div style={{ fontFamily: UI_FONT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.55, color: 'var(--t-text)' }}>
      {segments.map((seg, i) => {
        if (seg.kind === 'md') {
          return <div key={`s:${i}`}>{renderMarkdownLines(seg.text, `s${i}`)}</div>;
        }
        if (seg.kind === 'fenced-html') {
          return <FencedHtmlBlock key={`s:${i}`} code={seg.code} theme={theme} />;
        }
        if (seg.kind === 'fenced-code') {
          return <CodeBlock key={`s:${i}`} code={seg.code} />;
        }
        if (seg.kind === 'svg') {
          return <InlineSvg key={`s:${i}`} html={seg.html} />;
        }
        // iframe
        return <PassthroughIframe key={`s:${i}`} html={seg.html} />;
      })}
    </div>
  );
}
