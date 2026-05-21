'use client';

/*
 * Throwaway design lab for the o8.md review surface (roughdraft ingestion,
 * Phase 4). ③ Inline is the chosen direction; ①② kept for reference. Renders
 * the SAME seeded spec + the handwritten margin-note "alive layer", and is
 * theme-aware (Light / Midnight toggle) via --lab-* CSS vars so we can confirm
 * it holds up in both. Hand-authored doc + notes mirror the RFM data contract.
 *
 *   /preview/o8md
 */

import { useState } from 'react';
import { O8SpecEditor } from '@/components/desktop/o8-panel/O8SpecEditor';

const HAND = "'Caveat', ui-rounded, cursive";
const PROSE = "'Inter', system-ui, sans-serif";
const MONO = "'SF Mono', 'JetBrains Mono', Menlo, monospace";

// ── theme-aware palettes (mirror o8's light/midnight surfaces) ──
type ThemeKey = 'light' | 'midnight';
const THEMES: Record<ThemeKey, Record<string, string>> = {
  light: {
    '--lab-page': '#EEEAE2',
    '--lab-paper': '#FBFAF7',
    '--lab-edge': '#F2EFE8',
    '--lab-raw': '#FFFFFF',
    '--lab-ink': '#23201C',
    '--lab-ink-soft': '#6B6557',
    '--lab-ink-faint': '#A8A092',
    '--lab-orange': '#E8590C',
    '--lab-hilite': 'rgba(245, 200, 66, 0.32)',
    '--lab-add': '#2F9E44',
    '--lab-del': '#E03131',
    '--lab-border': 'rgba(35, 32, 28, 0.12)',
    '--lab-grain': '0.035',
  },
  midnight: {
    '--lab-page': '#0E1014',
    '--lab-paper': '#1A1E24',
    '--lab-edge': '#15181D',
    '--lab-raw': '#12151A',
    '--lab-ink': '#E8ECF2',
    '--lab-ink-soft': '#A6AEBC',
    '--lab-ink-faint': '#6B7280',
    '--lab-orange': '#FF8A4C',
    '--lab-hilite': 'rgba(255, 180, 90, 0.16)',
    '--lab-add': '#5BD27A',
    '--lab-del': '#FF6B6B',
    '--lab-border': 'rgba(255, 255, 255, 0.12)',
    '--lab-grain': '0.06',
  },
};

const GRAIN = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

// ── seeded review model (mirrors the RFM data contract) ──
type Author = 'user' | 'AI';
interface Note {
  author: Author;
  text: string;
  suggestion?: boolean;
  replies?: { author: Author; text: string }[];
  resolved?: boolean;
}
const NOTES: Record<string, Note> = {
  s1: { author: 'AI', text: 'cut "without a sales call"? tightens the promise', suggestion: true },
  c1: {
    author: 'user',
    text: 'Do we still want 3 tiers, or 2 + enterprise?',
    replies: [{ author: 'AI', text: '2 + enterprise tested better — switching the copy.' }],
  },
  c2: { author: 'AI', text: 'nice — this lands harder than "fast"' },
  c3: { author: 'AI', text: 'shipped', suggestion: true, resolved: true },
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
  { type: 'p', segs: [
    { t: 'text', s: 'Ship the marketing site that turns visitors into signups ' },
    { t: 'sub', old: 'without a sales call', neu: 'in one click', note: 's1' },
    { t: 'text', s: '.' },
  ] },
  { type: 'h2', text: 'Active scope' },
  { type: 'li', checked: true, segs: [{ t: 'text', s: 'Hero + waitlist form' }] },
  { type: 'li', checked: false, segs: [
    { t: 'text', s: 'Pricing page with the ' },
    { t: 'anchor', s: 'three tiers', note: 'c1' },
  ] },
  { type: 'li', checked: false, segs: [{ t: 'text', s: 'Connect the waitlist to Clerk' }] },
  { type: 'h2', text: 'Notes' },
  { type: 'p', segs: [
    { t: 'text', s: 'Use a ' },
    { t: 'anchor', s: 'local-first framing', note: 'c2' },
    { t: 'text', s: " in the copy — it's the real differentiator. " },
    { t: 'add', s: 'Mention the open-source repo.', note: 'c3' },
  ] },
];

const RAW_MD = `# Eyes Web — launch spec

## Mission
Ship the marketing site that turns visitors into signups {~~without a sales call~>in one click~~}{id="s1" by="AI"}.

## Active scope
- [x] Hero + waitlist form
- [ ] Pricing page with the {==three tiers==}{>>Do we still want 3 tiers, or 2 + enterprise?<<}{id="c1" by="user"}{>>2 + enterprise tested better — switching.<<}{id="c4" by="AI" re="c1"}
- [ ] Connect the waitlist to Clerk

## Notes
Use a {==local-first framing==}{>>nice — this lands harder than "fast"<<}{id="c2" by="AI"} in the copy — it's the real differentiator. {++Mention the open-source repo.++}{id="c3" by="AI" status="resolved"}`;

// ── inline segment renderers ──
function InlineSeg({ seg, dot }: { seg: Seg; dot?: boolean }) {
  if (seg.t === 'text') return <span>{seg.s}</span>;
  if (seg.t === 'anchor') {
    return (
      <span style={{ background: 'var(--lab-hilite)', borderRadius: 3, paddingLeft: 2, paddingRight: 2 }}>
        {seg.s}
        {dot ? <span style={{ color: 'var(--lab-orange)', fontSize: 9, verticalAlign: 'super', marginLeft: 1 }}>●</span> : null}
      </span>
    );
  }
  if (seg.t === 'sub') {
    return (
      <span>
        <span style={{ color: 'var(--lab-del)', textDecoration: 'line-through', textDecorationColor: 'currentColor', opacity: 0.85 }}>{seg.old}</span>
        <span style={{ color: 'var(--lab-add)' }}> {seg.neu}</span>
      </span>
    );
  }
  return <span style={{ color: 'var(--lab-add)', textDecoration: 'underline', textDecorationStyle: 'dotted' }}>{seg.s}</span>;
}

function notesForBlock(block: Block): string[] {
  if (block.type !== 'p' && block.type !== 'li') return [];
  return block.segs.flatMap((s) => ('note' in s ? [s.note] : []));
}

// ── the alive layer: a handwritten margin note (with leader + accept/reject) ──
function MarginNote({ id }: { id: string }) {
  const note = NOTES[id];
  if (!note) return null;
  const ink = note.author === 'AI' ? 'var(--lab-orange)' : 'var(--lab-ink-soft)';
  return (
    <div style={{ marginBottom: 12, opacity: note.resolved ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* dotted leader back toward the divider/anchor */}
        <span style={{ width: 14, height: 0, borderTop: '1px dotted var(--lab-ink-faint)', flexShrink: 0, marginLeft: -18 }} />
        <span style={{ fontFamily: PROSE, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: note.author === 'AI' ? 'var(--lab-orange)' : 'var(--lab-ink-faint)' }}>
          {note.author === 'AI' ? 'o8' : 'you'}
        </span>
        {note.resolved ? <span style={{ fontFamily: PROSE, fontSize: 9, color: 'var(--lab-ink-faint)' }}>resolved</span> : null}
      </div>
      <div style={{ fontFamily: HAND, fontSize: 18, lineHeight: 1.15, color: ink, textDecoration: note.resolved ? 'line-through' : 'none' }}>
        {note.text}
      </div>
      {note.replies?.map((r, i) => (
        <div key={i} style={{ fontFamily: HAND, fontSize: 16, lineHeight: 1.15, color: r.author === 'AI' ? 'var(--lab-orange)' : 'var(--lab-ink-soft)', paddingLeft: 12, marginTop: 3 }}>
          ↳ {r.text}
        </div>
      ))}
      {note.suggestion && !note.resolved ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
          <Chip label="Accept" tone="add" />
          <Chip label="Dismiss" tone="muted" />
        </div>
      ) : null}
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone: 'add' | 'muted' }) {
  const color = tone === 'add' ? 'var(--lab-add)' : 'var(--lab-ink-faint)';
  return (
    <button type="button" style={{ cursor: 'pointer', fontFamily: PROSE, fontSize: 10.5, fontWeight: 600, color, background: 'transparent', border: `1px solid ${color}`, borderRadius: 6, paddingTop: 2, paddingBottom: 2, paddingLeft: 8, paddingRight: 8 }}>
      {label}
    </button>
  );
}

function BlockProse({ block, dot }: { block: Block; dot?: boolean }) {
  if (block.type === 'h1') return <div style={{ fontFamily: PROSE, fontSize: 22, fontWeight: 600, color: 'var(--lab-ink)', letterSpacing: '-0.02em' }}>{block.text}</div>;
  if (block.type === 'h2') return <div style={{ fontFamily: PROSE, fontSize: 12, fontWeight: 600, color: 'var(--lab-ink-soft)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{block.text}</div>;
  if (block.type === 'li') {
    return (
      <div style={{ display: 'flex', gap: 8, fontFamily: PROSE, fontSize: 14.5, lineHeight: 1.6, color: 'var(--lab-ink)' }}>
        <span style={{ color: block.checked ? 'var(--lab-add)' : 'var(--lab-ink-faint)', flexShrink: 0 }}>{block.checked ? '☑' : '☐'}</span>
        <span style={{ textDecoration: block.checked ? 'line-through' : 'none', textDecorationColor: 'var(--lab-border)' }}>
          {block.segs.map((s, i) => <InlineSeg key={i} seg={s} dot={dot} />)}
        </span>
      </div>
    );
  }
  return (
    <div style={{ fontFamily: PROSE, fontSize: 14.5, lineHeight: 1.65, color: 'var(--lab-ink)' }}>
      {block.segs.map((s, i) => <InlineSeg key={i} seg={s} dot={dot} />)}
    </div>
  );
}

// ── paper sheet: per-block ROWS so each note aligns to its own line ──
function PaperSheet({ live, dot }: { live?: boolean; dot?: boolean }) {
  return (
    <div style={{ position: 'relative', background: 'var(--lab-paper)', borderRadius: 12, border: `1px solid var(--lab-border)`, boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 14px 36px rgba(0,0,0,0.10)', overflow: 'hidden', outline: live ? '2px solid var(--lab-orange)' : 'none', outlineOffset: -1 }}>
      {/* paper grain */}
      <div aria-hidden style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN, opacity: 'var(--lab-grain)' as unknown as number, pointerEvents: 'none', mixBlendMode: 'overlay' }} />
      <div style={{ position: 'relative', paddingTop: 22, paddingBottom: 26 }}>
        {DOC.map((block, i) => {
          const ids = notesForBlock(block);
          const heading = block.type === 'h1' || block.type === 'h2';
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', marginTop: heading ? 14 : 0 }}>
              <div style={{ flex: 1, minWidth: 0, paddingLeft: 32, paddingRight: 22, paddingTop: 3, paddingBottom: 3, borderRight: '1px dashed var(--lab-border)' }}>
                <BlockProse block={block} dot={dot} />
                {live && i === DOC.length - 1 ? <span style={{ display: 'inline-block', width: 1.5, height: 15, background: 'var(--lab-orange)', marginLeft: 1, verticalAlign: 'text-bottom' }} /> : null}
              </div>
              <div style={{ width: 230, flexShrink: 0, paddingLeft: 22, paddingRight: 16, paddingTop: 3 }}>
                {ids.map((id) => <MarginNote key={id} id={id} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverlayApproach() {
  const parts = RAW_MD.split(/(\{[=+~>-][\s\S]*?\}(?:\{[^}]*\})?)/g);
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <pre style={{ flex: 1, minWidth: 0, margin: 0, padding: 20, background: 'var(--lab-raw)', borderRadius: 12, border: '1px solid var(--lab-border)', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, color: 'var(--lab-ink)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
        {parts.map((p, i) => /^\{[=+~>-]/.test(p)
          ? <span key={i} style={{ background: 'var(--lab-hilite)', color: 'var(--lab-orange)', borderRadius: 3 }}>{p}</span>
          : <span key={i}>{p}</span>)}
      </pre>
      <div style={{ width: 230, flexShrink: 0 }}>
        <div style={{ fontFamily: PROSE, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--lab-ink-faint)', marginBottom: 8 }}>Threads</div>
        {Object.keys(NOTES).map((id) => <MarginNote key={id} id={id} />)}
      </div>
    </div>
  );
}

function ReadingApproach() {
  const [mode, setMode] = useState<'reading' | 'editing'>('reading');
  return (
    <div>
      <div style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 9, background: 'var(--lab-edge)', border: '1px solid var(--lab-border)', marginBottom: 12 }}>
        {(['reading', 'editing'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            style={{ border: 'none', cursor: 'pointer', borderRadius: 7, paddingTop: 5, paddingBottom: 5, paddingLeft: 12, paddingRight: 12, fontFamily: PROSE, fontSize: 12, fontWeight: 600, textTransform: 'capitalize', background: mode === m ? 'var(--lab-paper)' : 'transparent', color: mode === m ? 'var(--lab-ink)' : 'var(--lab-ink-soft)' }}>
            {m}
          </button>
        ))}
      </div>
      {mode === 'reading'
        ? <PaperSheet />
        : <pre style={{ margin: 0, padding: 20, background: 'var(--lab-raw)', borderRadius: 12, border: '1px solid var(--lab-border)', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, color: 'var(--lab-ink)', whiteSpace: 'pre-wrap' }}>{RAW_MD}</pre>}
    </div>
  );
}

function InlineApproach() {
  return (
    <div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, fontFamily: PROSE, fontSize: 11, color: 'var(--lab-ink-soft)' }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--lab-add)', display: 'inline-block' }} />
        editing live · markup hidden · marks render in place · ● = note
      </div>
      <PaperSheet live dot />
    </div>
  );
}

function LiveApproach() {
  const [doc, setDoc] = useState(RAW_MD);
  return (
    <div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, fontFamily: PROSE, fontSize: 11, color: 'var(--lab-ink-soft)' }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--lab-add)', display: 'inline-block' }} />
        real CodeMirror 6 · type to edit · markup hides as you go · ● = note (margin rail + accept/reject next)
      </div>
      <div
        style={{
          height: 460,
          background: 'var(--lab-paper)',
          borderRadius: 12,
          border: '1px solid var(--lab-border)',
          boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 14px 36px rgba(0,0,0,0.10)',
          paddingLeft: 28,
          paddingRight: 16,
          overflowY: 'auto',
          ['--o8ed-ink']: 'var(--lab-ink)',
          ['--o8ed-ink-soft']: 'var(--lab-ink-soft)',
          ['--o8ed-ink-faint']: 'var(--lab-ink-faint)',
          ['--o8ed-orange']: 'var(--lab-orange)',
          ['--o8ed-add']: 'var(--lab-add)',
          ['--o8ed-del']: 'var(--lab-del)',
          ['--o8ed-hilite']: 'var(--lab-hilite)',
        } as React.CSSProperties}
      >
        <O8SpecEditor value={doc} onChange={setDoc} />
      </div>
    </div>
  );
}

const APPROACHES = [
  { key: 'live', label: '④ Live (CodeMirror)', sub: 'the real editor — type into it · markup hides in place · margin rail + accept/reject next', node: <LiveApproach /> },
  { key: 'inline', label: '③ Inline (target)', sub: 'static target — edit + see marks together · markup hidden · accept/reject in the margin', node: <InlineApproach /> },
  { key: 'reading', label: '② Reading / Editing', sub: 'clean reading view + raw edit toggle', node: <ReadingApproach /> },
  { key: 'overlay', label: '① Overlay textarea', sub: 'edit raw · marks glow behind · lightest', node: <OverlayApproach /> },
] as const;

export default function O8mdPreviewPage() {
  const [active, setActive] = useState<(typeof APPROACHES)[number]['key']>('live');
  const [theme, setTheme] = useState<ThemeKey>('light');
  const current = APPROACHES.find((a) => a.key === active) ?? APPROACHES[0];
  return (
    <div style={{ minHeight: '100vh', background: 'var(--lab-page)', paddingTop: 36, paddingBottom: 80, paddingLeft: 24, paddingRight: 24, fontFamily: PROSE, ...THEMES[theme] } as React.CSSProperties}>
      {/* Caveat now comes from the self-hosted @font-face in globals.css (CSP-safe). */}
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');"}</style>
      <div style={{ maxWidth: 900, marginLeft: 'auto', marginRight: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: PROSE, fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--lab-orange)', marginBottom: 6 }}>o8.md — design lab</div>
            <h1 style={{ fontFamily: PROSE, fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--lab-ink)', margin: 0 }}>You write. o8 annotates.</h1>
          </div>
          {/* theme toggle — must look good in both */}
          <div style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 9, background: 'var(--lab-edge)', border: '1px solid var(--lab-border)' }}>
            {(['light', 'midnight'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTheme(t)}
                style={{ border: 'none', cursor: 'pointer', borderRadius: 7, paddingTop: 5, paddingBottom: 5, paddingLeft: 12, paddingRight: 12, fontFamily: PROSE, fontSize: 12, fontWeight: 600, textTransform: 'capitalize', background: theme === t ? 'var(--lab-paper)' : 'transparent', color: theme === t ? 'var(--lab-ink)' : 'var(--lab-ink-soft)' }}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <p style={{ fontFamily: PROSE, fontSize: 14, lineHeight: 1.6, color: 'var(--lab-ink-soft)', maxWidth: 620, marginTop: 8 }}>
          Your prose stays in clean ink; o8&apos;s pointers are the handwritten notes in the margin
          (orange = o8, grey = you). Suggestions carry Accept / Dismiss.
        </p>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, marginBottom: 16, flexWrap: 'wrap' }}>
          {APPROACHES.map((a) => (
            <button key={a.key} type="button" onClick={() => setActive(a.key)}
              style={{ textAlign: 'left', cursor: 'pointer', borderRadius: 10, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 14, border: `1px solid ${active === a.key ? 'var(--lab-orange)' : 'var(--lab-border)'}`, background: active === a.key ? 'var(--lab-paper)' : 'transparent' }}>
              <div style={{ fontFamily: PROSE, fontSize: 13, fontWeight: 600, color: active === a.key ? 'var(--lab-ink)' : 'var(--lab-ink-soft)' }}>{a.label}</div>
              <div style={{ fontFamily: PROSE, fontSize: 11, color: 'var(--lab-ink-faint)', marginTop: 2 }}>{a.sub}</div>
            </button>
          ))}
        </div>

        {current.node}
      </div>
    </div>
  );
}
