'use client';

/*
 * Throwaway design lab for the o8.md review surface (roughdraft ingestion,
 * Phase 4). Renders the SAME seeded spec three ways so we can pick the render
 * model before building it into O8SpecPane. Not wired to live data — the doc +
 * notes below are hand-authored, but mirror the real RFM data contract
 * (author / anchorText / text / kind), so the winner ports straight onto
 * extractRoughdraftReviewIndex output.
 *
 *   /preview/o8md
 */

import { useState } from 'react';

// ── palette (o8 design language: paper, ink, one orange) ──
const PAPER = '#FBFAF7';
const PAPER_EDGE = '#F2EFE8';
const INK = '#23201C';
const INK_SOFT = '#6B6557';
const INK_FAINT = '#A8A092';
const ORANGE = '#E8590C'; // AI's hand
const HILITE = 'rgba(245, 200, 66, 0.30)';
const ADD = '#2F9E44';
const DEL = '#E03131';
const BORDER = 'rgba(35, 32, 28, 0.10)';
const HAND = "'Caveat', ui-rounded, cursive";
const PROSE = "'Inter', system-ui, sans-serif";
const MONO = "'SF Mono', 'JetBrains Mono', Menlo, monospace";

// ── seeded review model (mirrors the RFM data contract) ──
type Author = 'user' | 'AI';
interface Note {
  author: Author;
  text: string;
  replies?: { author: Author; text: string }[];
  resolved?: boolean;
}
const NOTES: Record<string, Note> = {
  c1: {
    author: 'user',
    text: 'Do we still want 3 tiers, or 2 + enterprise?',
    replies: [{ author: 'AI', text: '2 + enterprise tested better — switching the copy.' }],
  },
  c2: { author: 'AI', text: 'nice — this lands harder than "fast"' },
  s1: { author: 'AI', text: 'cut "without a sales call"? tightens the promise' },
  c3: { author: 'AI', text: 'shipped ✓', resolved: true },
};

type Seg =
  | { t: 'text'; s: string }
  | { t: 'anchor'; s: string; note: string }
  | { t: 'sub'; old: string; neu: string; note: string }
  | { t: 'add'; s: string; note: string };

type Block =
  | { type: 'h1'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'li'; checked: boolean; segs: Seg[] }
  | { type: 'p'; segs: Seg[] };

const DOC: Block[] = [
  { type: 'h1', text: 'Eyes Web — launch spec' },
  { type: 'h2', text: 'Mission' },
  {
    type: 'p',
    segs: [
      { t: 'text', s: 'Ship the marketing site that turns visitors into signups ' },
      { t: 'sub', old: 'without a sales call', neu: 'in one click', note: 's1' },
      { t: 'text', s: '.' },
    ],
  },
  { type: 'h2', text: 'Active scope' },
  { type: 'li', checked: true, segs: [{ t: 'text', s: 'Hero + waitlist form' }] },
  {
    type: 'li',
    checked: false,
    segs: [
      { t: 'text', s: 'Pricing page with the ' },
      { t: 'anchor', s: 'three tiers', note: 'c1' },
    ],
  },
  { type: 'li', checked: false, segs: [{ t: 'text', s: 'Connect the waitlist to Clerk' }] },
  { type: 'h2', text: 'Notes' },
  {
    type: 'p',
    segs: [
      { t: 'text', s: 'Use a ' },
      { t: 'anchor', s: 'local-first framing', note: 'c2' },
      { t: 'text', s: " in the copy — it's the real differentiator. " },
      { t: 'add', s: 'Mention the open-source repo.', note: 'c3' },
    ],
  },
];

const RAW_MD = `# Eyes Web — launch spec

## Mission
Ship the marketing site that turns visitors into signups {~~without a sales call~>in one click~~}{id="s1" by="AI"}.

## Active scope
- [x] Hero + waitlist form
- [ ] Pricing page with the {==three tiers==}{>>Do we still want 3 tiers, or 2 + enterprise?<<}{id="c1" by="user"}
- [ ] Connect the waitlist to Clerk

## Notes
Use a {==local-first framing==}{>>nice — this lands harder than "fast"<<}{id="c2" by="AI"} in the copy — it's the real differentiator. {++Mention the open-source repo.++}{id="c3" by="AI" status="resolved"}`;

// ── inline segment renderers (clean / rendered form) ──
function InlineSeg({ seg }: { seg: Seg }) {
  if (seg.t === 'text') return <span>{seg.s}</span>;
  if (seg.t === 'anchor') {
    return <span style={{ background: HILITE, borderRadius: 3, paddingLeft: 2, paddingRight: 2 }}>{seg.s}</span>;
  }
  if (seg.t === 'sub') {
    return (
      <span>
        <span style={{ color: DEL, textDecoration: 'line-through', textDecorationColor: 'rgba(224,49,49,0.6)' }}>{seg.old}</span>
        <span style={{ color: ADD }}> {seg.neu}</span>
      </span>
    );
  }
  // add
  return <span style={{ color: ADD, textDecoration: 'underline', textDecorationColor: 'rgba(47,158,68,0.5)' }}>{seg.s}</span>;
}

function notesForBlock(block: Block): string[] {
  if (block.type !== 'p' && block.type !== 'li') return [];
  return block.segs.flatMap((s) => ('note' in s ? [s.note] : []));
}

// ── the alive layer: a handwritten margin note ──
function MarginNote({ id }: { id: string }) {
  const note = NOTES[id];
  if (!note) return null;
  const ink = note.author === 'AI' ? ORANGE : INK_SOFT;
  return (
    <div style={{ marginBottom: 10, opacity: note.resolved ? 0.45 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: PROSE, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: note.author === 'AI' ? ORANGE : INK_FAINT }}>
          {note.author === 'AI' ? 'o8' : 'you'}
        </span>
        {note.resolved ? <span style={{ fontFamily: PROSE, fontSize: 9, color: INK_FAINT }}>resolved</span> : null}
      </div>
      <div style={{ fontFamily: HAND, fontSize: 18, lineHeight: 1.15, color: ink, textDecoration: note.resolved ? 'line-through' : 'none' }}>
        {note.text}
      </div>
      {note.replies?.map((r, i) => (
        <div key={i} style={{ fontFamily: HAND, fontSize: 16, lineHeight: 1.15, color: r.author === 'AI' ? ORANGE : INK_SOFT, paddingLeft: 12, marginTop: 3 }}>
          ↳ {r.text}
        </div>
      ))}
    </div>
  );
}

// ── shared block prose renderer ──
function BlockProse({ block, editorial }: { block: Block; editorial?: boolean }) {
  if (block.type === 'h1') return <div style={{ fontFamily: PROSE, fontSize: 22, fontWeight: 600, color: INK, letterSpacing: '-0.02em', marginBottom: 4 }}>{block.text}</div>;
  if (block.type === 'h2') return <div style={{ fontFamily: PROSE, fontSize: 13, fontWeight: 600, color: INK_SOFT, letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: 14, marginBottom: 4 }}>{block.text}</div>;
  if (block.type === 'li') {
    return (
      <div style={{ display: 'flex', gap: 8, fontFamily: PROSE, fontSize: 14.5, lineHeight: 1.6, color: INK }}>
        <span style={{ color: block.checked ? ADD : INK_FAINT, flexShrink: 0 }}>{block.checked ? '☑' : '☐'}</span>
        <span style={{ textDecoration: block.checked ? 'line-through' : 'none', textDecorationColor: BORDER }}>
          {block.segs.map((s, i) => <InlineSeg key={i} seg={s} />)}
        </span>
      </div>
    );
  }
  return (
    <div style={{ fontFamily: PROSE, fontSize: 14.5, lineHeight: 1.65, color: INK }}>
      {block.segs.map((s, i) => <InlineSeg key={i} seg={s} />)}
      {editorial ? <span style={{ display: 'inline-block', width: 1, height: 16, background: ORANGE, marginLeft: 1, verticalAlign: 'text-bottom', opacity: 0.7 }} /> : null}
    </div>
  );
}

// ── a paper sheet that lays prose left, handwritten notes in the right margin ──
function PaperSheet({ editorial, caret }: { editorial?: boolean; caret?: boolean }) {
  return (
    <div style={{ background: PAPER, borderRadius: 12, border: `1px solid ${BORDER}`, boxShadow: '0 1px 0 rgba(35,32,28,0.04), 0 12px 32px rgba(35,32,28,0.06)', overflow: 'hidden' }}>
      <div style={{ display: 'flex' }}>
        {/* prose column */}
        <div style={{ flex: 1, minWidth: 0, paddingTop: 28, paddingBottom: 28, paddingLeft: 32, paddingRight: 24, borderRight: `1px dashed ${BORDER}` }}>
          {DOC.map((block, i) => (
            <div key={i} style={{ marginBottom: block.type === 'h1' || block.type === 'h2' ? 0 : 6 }}>
              <BlockProse block={block} editorial={editorial && i === DOC.length - 1 && caret} />
            </div>
          ))}
        </div>
        {/* margin column — the alive layer */}
        <div style={{ width: 230, flexShrink: 0, paddingTop: 28, paddingBottom: 28, paddingLeft: 18, paddingRight: 18, background: PAPER_EDGE }}>
          {DOC.map((block, i) => {
            const ids = notesForBlock(block);
            if (ids.length === 0) return <div key={i} style={{ height: block.type === 'h1' ? 30 : block.type === 'h2' ? 30 : 24 }} />;
            return (
              <div key={i} style={{ minHeight: 24, marginBottom: 6 }}>
                {ids.map((id) => <MarginNote key={id} id={id} />)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── ① Overlay-highlight textarea (you edit raw; marks glow behind) ──
function OverlayApproach() {
  // Color the RFM markers inside the raw text to mimic the highlight overlay.
  const parts = RAW_MD.split(/(\{[=+~>-][\s\S]*?\}(?:\{[^}]*\})?)/g);
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <pre style={{ flex: 1, minWidth: 0, margin: 0, padding: 20, background: '#FFFFFF', borderRadius: 12, border: `1px solid ${BORDER}`, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, color: INK, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
        {parts.map((p, i) =>
          /^\{[=+~>-]/.test(p)
            ? <span key={i} style={{ background: HILITE, color: '#8A5200', borderRadius: 3 }}>{p}</span>
            : <span key={i}>{p}</span>,
        )}
      </pre>
      <div style={{ width: 230, flexShrink: 0 }}>
        <div style={{ fontFamily: PROSE, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: INK_FAINT, marginBottom: 8 }}>Threads</div>
        {Object.keys(NOTES).map((id) => <MarginNote key={id} id={id} />)}
      </div>
    </div>
  );
}

// ── ② Reading / Editing toggle (Rough Draft feel) ──
function ReadingApproach() {
  const [mode, setMode] = useState<'reading' | 'editing'>('reading');
  return (
    <div>
      <div style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 9, background: PAPER_EDGE, border: `1px solid ${BORDER}`, marginBottom: 12 }}>
        {(['reading', 'editing'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{ border: 'none', cursor: 'pointer', borderRadius: 7, paddingTop: 5, paddingBottom: 5, paddingLeft: 12, paddingRight: 12, fontFamily: PROSE, fontSize: 12, fontWeight: 600, textTransform: 'capitalize', background: mode === m ? PAPER : 'transparent', color: mode === m ? INK : INK_SOFT, boxShadow: mode === m ? '0 1px 2px rgba(35,32,28,0.12)' : 'none' }}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === 'reading'
        ? <PaperSheet />
        : <pre style={{ margin: 0, padding: 20, background: '#FFFFFF', borderRadius: 12, border: `1px solid ${BORDER}`, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, color: INK, whiteSpace: 'pre-wrap' }}>{RAW_MD}</pre>}
    </div>
  );
}

// ── ③ CodeMirror-style inline (always live; markup hidden; marks in place) ──
function InlineApproach() {
  return (
    <div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, fontFamily: PROSE, fontSize: 11, color: INK_SOFT }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: ADD, display: 'inline-block' }} />
        editing live · markup hidden · marks render in place
      </div>
      <PaperSheet editorial caret />
    </div>
  );
}

const APPROACHES = [
  { key: 'overlay', label: '① Overlay textarea', sub: 'edit raw · marks glow behind · lightest', node: <OverlayApproach /> },
  { key: 'reading', label: '② Reading / Editing', sub: 'clean reading view + raw edit toggle · the alive layer sings', node: <ReadingApproach /> },
  { key: 'inline', label: '③ Inline (CodeMirror)', sub: 'edit + see marks together · markup hidden · best feel, new dep', node: <InlineApproach /> },
] as const;

export default function O8mdPreviewPage() {
  const [active, setActive] = useState<(typeof APPROACHES)[number]['key']>('reading');
  const current = APPROACHES.find((a) => a.key === active) ?? APPROACHES[1];
  return (
    <div style={{ minHeight: '100vh', background: '#EEEAE2', paddingTop: 40, paddingBottom: 80, paddingLeft: 24, paddingRight: 24, fontFamily: PROSE }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');"}</style>
      <div style={{ maxWidth: 880, marginLeft: 'auto', marginRight: 'auto' }}>
        <div style={{ fontFamily: PROSE, fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: ORANGE, marginBottom: 6 }}>o8.md — design lab</div>
        <h1 style={{ fontFamily: PROSE, fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: INK, margin: 0 }}>You write. o8 annotates.</h1>
        <p style={{ fontFamily: PROSE, fontSize: 14, lineHeight: 1.6, color: INK_SOFT, maxWidth: 620, marginTop: 8 }}>
          Same spec, three render models. Your prose stays in clean ink; o8&apos;s pointers are the
          handwritten notes in the margin (orange = o8&apos;s hand, grey = yours). Pick the one that feels right.
        </p>

        {/* switcher */}
        <div style={{ display: 'flex', gap: 8, marginTop: 20, marginBottom: 18, flexWrap: 'wrap' }}>
          {APPROACHES.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => setActive(a.key)}
              style={{ textAlign: 'left', cursor: 'pointer', borderRadius: 10, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 14, border: `1px solid ${active === a.key ? ORANGE : BORDER}`, background: active === a.key ? '#FFFFFF' : 'transparent', boxShadow: active === a.key ? '0 2px 8px rgba(232,89,12,0.10)' : 'none' }}
            >
              <div style={{ fontFamily: PROSE, fontSize: 13, fontWeight: 600, color: active === a.key ? INK : INK_SOFT }}>{a.label}</div>
              <div style={{ fontFamily: PROSE, fontSize: 11, color: INK_FAINT, marginTop: 2 }}>{a.sub}</div>
            </button>
          ))}
        </div>

        <div style={{ fontFamily: PROSE, fontSize: 12, color: INK_SOFT, marginBottom: 12 }}>{current.sub}</div>
        {current.node}
      </div>
    </div>
  );
}
