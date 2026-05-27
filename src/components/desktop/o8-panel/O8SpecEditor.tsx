'use client';

/*
 * O8SpecEditor — the real CodeMirror 6 inline editor for o8.md (roughdraft
 * Phase 4, model ③). You edit raw markdown; CriticMarkup review markers are
 * HIDDEN and rendered as inline marks in place; the operator's / agent's
 * comments + suggestions render as handwritten notes in a right rail aligned
 * to their line. Suggestions carry Accept / Dismiss (real doc mutations).
 *
 *   {==anchor==}            → highlighted anchor + ● note dot
 *   {>>comment<<}{meta}     → hidden (the text lives in the margin rail)
 *   {~~old~>new~~}{meta}    → old (strike) → new (green)
 *   {++text++}{meta}        → text (green, dotted underline)
 *   {--text--}{meta}        → text (red strike)
 *
 * Theme-agnostic: all colors come from --o8ed-* CSS vars the PARENT sets
 * (O8SpecPane maps them off --t-* tokens; the lab maps them off --lab-*).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { EditorState, StateField, StateEffect, Annotation, type Extension, type Range } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { extractRoughdraftReviewIndex } from '@/lib/o8md/rfm';
import { specImageDropPaste } from './spec-image-upload';
import { specImageRender, specRepoPathCompartment, specRepoPathFacet } from './spec-image-widget';

const HAND = "'Caveat', ui-rounded, cursive";
const PROSE = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, system-ui, sans-serif";
const RAIL_W = 220;

// A block spacer that reserves vertical room in the prose so a margin note can
// sit beside its anchor without colliding with the note above it. Injected
// "only when needed" by recompute()'s placement walk.
class SpacerWidget extends WidgetType {
  constructor(readonly h: number) { super(); }
  eq(o: SpacerWidget) { return o.h === this.h; }
  toDOM() { const d = document.createElement('div'); d.style.height = `${this.h}px`; d.setAttribute('aria-hidden', 'true'); return d; }
  get estimatedHeight() { return this.h; }
  ignoreEvent() { return true; }
}
const setSpacers = StateEffect.define<DecorationSet>();
const spacerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    let d = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setSpacers)) d = e.value;
    return d;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface O8SpecEditorProps {
  value: string;
  onChange: (value: string) => void;
  // Repo root for inline image upload (drop/paste → <repo>/o8-assets/). When
  // absent (e.g. the standalone editor lab) image drop/paste is disabled and the
  // editor stays a pure markdown surface.
  repoPath?: string | null;
}

// ── widgets ──
class DotWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = '●';
    span.setAttribute('aria-hidden', 'true');
    span.style.cssText = 'color: var(--o8ed-orange); font-size: 9px; vertical-align: super; margin-left: 1px;';
    return span;
  }
  eq(): boolean { return true; }
  get estimatedHeight(): number { return -1; }
}
class ArrowWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = ' → ';
    span.setAttribute('aria-hidden', 'true');
    span.style.cssText = 'color: var(--o8ed-ink-soft); opacity: 0.6;';
    return span;
  }
  eq(): boolean { return true; }
  get estimatedHeight(): number { return -1; }
}

// interactive task checkbox — hides `- [ ] ` / `- [x] `, shows a clickable glyph
class CheckWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super(); }
  eq(o: CheckWidget): boolean { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.textContent = this.checked ? '☑ ' : '☐ ';
    span.style.cssText = `cursor: pointer; user-select: none; color: ${this.checked ? 'var(--o8ed-add)' : 'var(--o8ed-ink-faint)'};`;
    span.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 3, to: this.pos + 4, insert: this.checked ? ' ' : 'x' } });
    };
    return span;
  }
  get estimatedHeight(): number { return -1; }
}

const HIDE = Decoration.replace({});
const ARROW = Decoration.replace({ widget: new ArrowWidget() });
const DOT = Decoration.widget({ widget: new DotWidget(), side: 1 });
const styleMark = (css: string) => Decoration.mark({ attributes: { style: css } });
const HILITE_MARK = styleMark('background: var(--o8ed-hilite); border-radius: 3px; padding: 0 1px;');
const ADD_MARK = styleMark('color: var(--o8ed-add); text-decoration: underline dotted;');
const DEL_MARK = styleMark('color: var(--o8ed-del); text-decoration: line-through;');
const SUBOLD_MARK = styleMark('color: var(--o8ed-del); text-decoration: line-through; opacity: 0.85;');
const SUBNEW_MARK = styleMark('color: var(--o8ed-add);');

// Marks programmatic doc replacements (load / external reconcile) so the
// update listener can skip firing onChange (and a redundant autosave) for them.
const External = Annotation.define<boolean>();

// Build both the decoration set AND the set of HIDDEN ranges (used as atomic
// ranges so the caret skips over hidden markup while editing). Marks (anchor
// highlight, sub text) stay editable — only replaced/hidden spans are atomic.
function buildAll(text: string): { deco: DecorationSet; atomic: DecorationSet } {
  const out: Range<Decoration>[] = [];
  const atomicOut: Range<Decoration>[] = [];
  const hide = (from: number, to: number, deco: Decoration = HIDE) => {
    if (to >= from) { out.push(deco.range(from, to)); if (to > from) atomicOut.push(deco.range(from, to)); }
  };
  const mark = (from: number, to: number, deco: Decoration) => { if (to > from) out.push(deco.range(from, to)); };
  for (const m of text.matchAll(/\{(?:id|by|at|re|status|resolved)="[^"]*"(?:\s+[A-Za-z_]+="[^"]*")*\}/g)) hide(m.index!, m.index! + m[0].length);
  for (const m of text.matchAll(/\{==([\s\S]*?)==\}/g)) {
    const start = m.index!; const innerStart = start + 3; const innerEnd = innerStart + m[1].length;
    hide(start, innerStart); mark(innerStart, innerEnd, HILITE_MARK); hide(innerEnd, start + m[0].length);
  }
  for (const m of text.matchAll(/\{>>[\s\S]*?<<\}(\{[^}]*\})?/g)) {
    const meta = m[1] ?? '';
    const commentEnd = m.index! + m[0].length - meta.length; // end of `<<}`, before metadata
    if (!/\bre=/.test(meta)) out.push(DOT.range(m.index!, m.index!)); // replies (re=…) don't emit a dot
    hide(m.index!, commentEnd);
  }
  for (const m of text.matchAll(/\{\+\+([\s\S]*?)\+\+\}/g)) {
    const start = m.index!; const innerStart = start + 3; const innerEnd = innerStart + m[1].length;
    hide(start, innerStart); mark(innerStart, innerEnd, ADD_MARK); hide(innerEnd, start + m[0].length);
  }
  for (const m of text.matchAll(/\{--([\s\S]*?)--\}/g)) {
    const start = m.index!; const innerStart = start + 3; const innerEnd = innerStart + m[1].length;
    hide(start, innerStart); mark(innerStart, innerEnd, DEL_MARK); hide(innerEnd, start + m[0].length);
  }
  for (const m of text.matchAll(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g)) {
    const start = m.index!; const oldStart = start + 3; const oldEnd = oldStart + m[1].length;
    const newStart = oldEnd + 2; const newEnd = newStart + m[2].length;
    hide(start, oldStart); mark(oldStart, oldEnd, SUBOLD_MARK); hide(oldEnd, newStart, ARROW);
    mark(newStart, newEnd, SUBNEW_MARK); hide(newEnd, start + m[0].length);
  }
  for (const m of text.matchAll(/^( *)- \[([ xX])\] /gm)) {
    const from = m.index! + m[1].length;
    hide(from, from + m[0].length - m[1].length, Decoration.replace({ widget: new CheckWidget(m[2].toLowerCase() === 'x', from) }));
  }
  for (const m of text.matchAll(/^(#{1,6})\s+/gm)) hide(m.index!, m.index! + m[0].length);
  return { deco: Decoration.set(out, true), atomic: Decoration.set(atomicOut, true) };
}

const reviewField = StateField.define<{ deco: DecorationSet; atomic: DecorationSet }>({
  create: (state) => buildAll(state.doc.toString()),
  update: (v, tr) => (tr.docChanged ? buildAll(tr.state.doc.toString()) : { deco: v.deco.map(tr.changes), atomic: v.atomic.map(tr.changes) }),
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '18px', fontWeight: '400', letterSpacing: '-0.2px', color: 'var(--o8ed-ink)' },
  { tag: tags.heading2, fontSize: '10px', fontWeight: '300', color: 'var(--o8ed-ink-faint)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  { tag: tags.heading3, fontSize: '13.5px', fontWeight: '400', letterSpacing: '-0.1px', color: 'var(--o8ed-ink-soft)' },
  { tag: tags.strong, fontWeight: '500', color: 'var(--o8ed-ink)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--o8ed-orange)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: "'SF Mono', Menlo, monospace", fontSize: '12px' },
]);

// height:auto + scroller overflow visible → the editor grows to content so the
// PARENT scrolls; margin notes positioned in the same (scroll-shared) space.
const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--o8ed-ink)', height: 'auto' },
  '.cm-scroller': { fontFamily: PROSE, fontSize: '13.5px', fontWeight: '300', letterSpacing: '-0.1px', lineHeight: '1.55', overflow: 'visible' },
  '.cm-content': { paddingTop: '22px', paddingBottom: '26px', paddingLeft: '4px', caretColor: 'var(--o8ed-orange)' },
  '.cm-line': { paddingLeft: '0', paddingRight: '8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--o8ed-orange)', borderLeftWidth: '1.5px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--o8ed-hilite)' },
});

interface NoteLayout {
  id: string;
  kind: string;
  author: string | null;
  text: string;
  suggestionKind?: string;
  originalText?: string;
  replacementText?: string;
  status: string | null;
  offset: number;
  endOffset: number;
  replies: { author: string | null; text: string }[];
  top: number;
}

export function O8SpecEditor({ value, onChange, repoPath }: O8SpecEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Kept in a ref so the (mount-once) image extension always reads the live repo
  // path without rebuilding the editor when the operator switches repos.
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const [notes, setNotes] = useState<NoteLayout[]>([]);
  // Caveat is a webfont. Until it loads the rail paints in a fallback (wider,
  // taller) font — wrong glyphs AND the char-count collision estimate (tuned
  // for Caveat's compact metrics) under-counts height, so notes overlap. A
  // webfont load fires no CM geometry event, so nothing retriggers the rail and
  // it stays broken until a reload (where Caveat is already cached). Gate the
  // rail on the font so notes only ever paint in Caveat.
  const [fontReady, setFontReady] = useState<boolean>(() => {
    try { return typeof document !== 'undefined' && !!document.fonts && document.fonts.check("18px 'Caveat'"); } catch { return false; }
  });

  const spacersRef = useRef<{ pos: number; height: number }[]>([]);
  const recompute = useCallback(() => {
    const view = viewRef.current; const wrap = wrapRef.current;
    if (!view || !wrap) return;
    const wrapTop = wrap.getBoundingClientRect().top;
    const idx = extractRoughdraftReviewIndex(view.state.doc.toString());
    const repliesByParent: Record<string, { author: string | null; text: string }[]> = {};
    for (const it of idx.items) {
      if (it.kind === 'reply' && it.parentId) (repliesByParent[it.parentId] ||= []).push({ author: it.author, text: it.text });
    }
    // Anchor each note at its marker's NATURAL y. coordsAtPos includes any
    // spacers we've already injected above it, so subtract those back out for a
    // spacer-free baseline — this keeps the reserve math below stable (the
    // baseline never depends on the spacers it produces, so it can't oscillate).
    const spacers = spacersRef.current;
    const spacerAbove = (offset: number) => {
      let h = 0;
      for (const s of spacers) if (s.pos <= offset) h += s.height;
      return h;
    };
    const layouts: NoteLayout[] = idx.items
      .filter((i) => i.kind === 'comment' || i.kind === 'suggestion')
      .map((i) => {
        let top = 0;
        try { const c = view.coordsAtPos(i.offset); if (c) top = Math.max(0, c.top - wrapTop - spacerAbove(i.offset)); } catch { /* off-screen */ }
        return {
          id: i.id, kind: i.kind, author: i.author, text: i.text, suggestionKind: i.suggestionKind,
          originalText: i.originalText, replacementText: i.replacementText, status: i.status,
          offset: i.offset, endOffset: i.endOffset, replies: repliesByParent[i.id] ?? [], top,
        };
      });
    // "Only when needed": where a note would collide with the one above it,
    // reserve prose room with a block spacer at its anchor line and let the note
    // sit beside its anchor — instead of drifting the note down off its line.
    layouts.sort((a, b) => a.top - b.top);
    const GAP = 16;
    const nextSpacers: { pos: number; height: number }[] = [];
    let pushDown = 0;
    let placedBottom = -1e9;
    for (const n of layouts) {
      const lines = Math.max(1, Math.ceil((n.text?.length ?? 0) / 24));
      const est = 22 + lines * 20 + n.replies.length * 20 + (n.kind === 'suggestion' ? 26 : 0);
      let top = n.top + pushDown;
      const deficit = Math.round(placedBottom + GAP - top);
      if (deficit > 0) {
        const pos = view.state.doc.lineAt(n.offset).from;
        const existing = nextSpacers.find((s) => s.pos === pos);
        if (existing) existing.height += deficit; else nextSpacers.push({ pos, height: deficit });
        pushDown += deficit;
        top += deficit;
      }
      n.top = top;
      placedBottom = top + est;
    }
    setNotes(layouts);
    // Re-apply spacers only when they actually changed (pos-sorted for a stable
    // compare), so the resulting geometry update can't trigger an endless
    // recompute → dispatch loop.
    nextSpacers.sort((a, b) => a.pos - b.pos);
    const same = nextSpacers.length === spacers.length
      && nextSpacers.every((s, k) => spacers[k] && spacers[k].pos === s.pos && spacers[k].height === s.height);
    if (!same) {
      spacersRef.current = nextSpacers;
      view.dispatch({ effects: setSpacers.of(Decoration.set(nextSpacers.map((s) => Decoration.widget({ widget: new SpacerWidget(s.height), block: true, side: -1 }).range(s.pos)), true)) });
    }
  }, []);
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  // Perf: the rail recompute re-parses the doc + forces layout (coordsAtPos),
  // so coalesce it to at most once per ~90ms. Decorations (markup hiding /
  // marks) stay instant — they live in the synchronous StateField, untouched.
  const recomputeTimerRef = useRef<number | null>(null);
  const scheduleRecompute = useCallback(() => {
    if (recomputeTimerRef.current != null) return;
    recomputeTimerRef.current = window.setTimeout(() => {
      recomputeTimerRef.current = null;
      recomputeRef.current();
    }, 90);
  }, []);
  const scheduleRecomputeRef = useRef(scheduleRecompute);
  scheduleRecomputeRef.current = scheduleRecompute;

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      syntaxHighlighting(mdHighlight),
      reviewField,
      spacerField,
      editorTheme,
      EditorView.lineWrapping,
      specImageDropPaste(() => repoPathRef.current ?? null),
      specImageRender(repoPath ?? null),
      EditorView.updateListener.of((u) => {
        // Skip onChange (and its debounced autosave) for programmatic loads.
        if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) {
          onChangeRef.current(u.state.doc.toString());
        }
        if (u.docChanged || u.geometryChanged) scheduleRecomputeRef.current();
      }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: hostRef.current });
    viewRef.current = view;
    // First paint: coordsAtPos is only accurate once CodeMirror has MEASURED the
    // laid-out content. A bare rAF fires before that measure pass, so CM's height
    // estimates for not-yet-measured content (inline images, headings, wrapped
    // lines) anchored the rail's notes at the wrong y until a manual scroll forced
    // a re-measure. requestMeasure runs its read AFTER the measure pass — but
    // recompute() DISPATCHES spacer effects, and dispatching inside a measure read
    // is illegal (re-entrant update → throws → breaks the editor). So go through
    // scheduleRecompute, which defers recompute to a timeout OUTSIDE the measure
    // cycle. Re-fire on settles that emit no CM geometry event: webfont swap
    // (fonts.ready) + inline-image decode (capture-phase load), plus backstops.
    const measureRecompute = () => viewRef.current?.requestMeasure({ read: () => scheduleRecomputeRef.current() });
    const raf = requestAnimationFrame(measureRecompute);
    const settleTimers = [150, 500].map((d) => window.setTimeout(measureRecompute, d));
    if (typeof document !== 'undefined' && document.fonts?.ready) document.fonts.ready.then(measureRecompute, () => {});
    const onImgLoad = (e: Event) => { if ((e.target as HTMLElement | null)?.tagName === 'IMG') scheduleRecomputeRef.current(); };
    view.contentDOM.addEventListener('load', onImgLoad, true);
    const ro = new ResizeObserver(() => scheduleRecomputeRef.current());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      cancelAnimationFrame(raf);
      settleTimers.forEach((t) => window.clearTimeout(t));
      view.contentDOM.removeEventListener('load', onImgLoad, true);
      if (recomputeTimerRef.current != null) clearTimeout(recomputeTimerRef.current);
      ro.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reveal + recompute the rail once Caveat lands (or immediately if cached).
  useEffect(() => {
    if (fontReady) return;
    let cancelled = false;
    const done = () => { if (!cancelled) { setFontReady(true); recomputeRef.current(); } };
    try {
      if (typeof document !== 'undefined' && document.fonts) document.fonts.load("18px 'Caveat'").then(done, done);
      else done();
    } catch { done(); }
    return () => { cancelled = true; };
  }, [fontReady]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: External.of(true) });
  }, [value]);

  // Keep the image-render facet in sync with the live repo path so repo-relative
  // srcs resolve correctly. The editor is mount-once, so reconfigure (don't
  // remount) when the operator switches repos.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: specRepoPathCompartment.reconfigure(specRepoPathFacet.of(repoPath ?? null)) });
  }, [repoPath]);

  // Accept / Dismiss a suggestion = a real doc mutation on its marker span.
  const resolveSuggestion = useCallback((note: NoteLayout, accept: boolean) => {
    const view = viewRef.current;
    if (!view) return;
    const marker = view.state.doc.sliceString(note.offset, note.endOffset);
    let insert = '';
    let mm: RegExpMatchArray | null;
    if ((mm = marker.match(/^\{~~([\s\S]*?)~>([\s\S]*?)~~\}/))) insert = accept ? mm[2] : mm[1]; // sub: new | old
    else if ((mm = marker.match(/^\{\+\+([\s\S]*?)\+\+\}/))) insert = accept ? mm[1] : ''; // add: keep | drop
    else if ((mm = marker.match(/^\{--([\s\S]*?)--\}/))) insert = accept ? '' : mm[1]; // del: drop | keep
    view.dispatch({ changes: { from: note.offset, to: note.endOffset, insert } });
  }, []);

  // Resolve a comment thread = add status="resolved" to its metadata (fades it).
  const resolveComment = useCallback((note: NoteLayout) => {
    const view = viewRef.current;
    if (!view) return;
    const marker = view.state.doc.sliceString(note.offset, note.endOffset);
    const lastBrace = marker.lastIndexOf('}');
    if (lastBrace < 0) return;
    const pos = note.offset + lastBrace;
    view.dispatch({ changes: { from: pos, to: pos, insert: ' status="resolved"' } });
  }, []);

  // Reply to a comment = splice an operator reply marker after it (re=parentId).
  const replyToComment = useCallback((note: NoteLayout, message: string) => {
    const view = viewRef.current;
    const text = message.trim();
    if (!view || !text || /<<\}|\+\+\}|--\}|~~\}|==\}/.test(text)) return;
    let max = 0;
    for (const it of extractRoughdraftReviewIndex(view.state.doc.toString()).items) {
      const m = /^c(\d+)$/.exec(it.id);
      if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    }
    // Insert at the END of the thread (after the last existing reply) so a new
    // reply lands at the bottom chronologically — not right under the parent.
    let insertPos = note.endOffset;
    for (const it of extractRoughdraftReviewIndex(view.state.doc.toString()).items) {
      if (it.parentId === note.id) insertPos = Math.max(insertPos, it.endOffset);
    }
    const reply = `{>>${text}<<}{id="c${max + 1}" by="user" at="${new Date().toISOString()}" re="${note.id}"}`;
    view.dispatch({ changes: { from: insertPos, to: insertPos, insert: reply } });
  }, []);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div ref={hostRef} style={{ flex: 1, minWidth: 0 }} />
        <div style={{ width: RAIL_W, flexShrink: 0 }} />
      </div>
      {fontReady && notes.map((n) => (
        // Keyed by id, so framer-motion only runs the enter on NEWLY mounted
        // notes (what a review just added) — existing notes don't re-animate on
        // recompute. They settle in from the margin: fade + a small slide.
        <motion.div
          key={n.id}
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          style={{ position: 'absolute', top: n.top, right: 0, width: RAIL_W - 16, paddingLeft: 14 }}
        >
          <MarginNote note={n} onResolve={resolveSuggestion} onResolveComment={resolveComment} onReply={replyToComment} />
        </motion.div>
      ))}
    </div>
  );
}

function MarginNote({ note, onResolve, onResolveComment, onReply }: {
  note: NoteLayout;
  onResolve: (n: NoteLayout, accept: boolean) => void;
  onResolveComment: (n: NoteLayout) => void;
  onReply: (n: NoteLayout, message: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const isAI = note.author === 'AI';
  const ink = isAI ? 'var(--o8ed-orange)' : 'var(--o8ed-ink-soft)';
  const resolved = note.status === 'resolved';
  const isSuggestion = note.kind === 'suggestion';
  const isComment = note.kind === 'comment';
  const submitReply = () => { onReply(note, draft); setDraft(''); setReplying(false); };
  return (
    <div style={{ opacity: resolved ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 12, height: 0, borderTop: '1px dotted var(--o8ed-ink-faint)', flexShrink: 0, marginLeft: -14 }} />
        <span style={{ fontFamily: PROSE, fontSize: 9, fontWeight: 300, letterSpacing: '0.05em', textTransform: 'uppercase', color: isAI ? 'var(--o8ed-orange)' : 'var(--o8ed-ink-faint)' }}>
          {isAI ? 'o8' : 'you'}
        </span>
        {resolved ? <span style={{ fontFamily: PROSE, fontSize: 9, color: 'var(--o8ed-ink-faint)' }}>resolved</span> : null}
      </div>
      <div style={{ fontFamily: HAND, fontSize: 18, lineHeight: 1.15, color: ink, textDecoration: resolved ? 'line-through' : 'none' }}>
        {isSuggestion && !note.text ? 'suggested edit' : note.text}
      </div>
      {note.replies.map((r, i) => (
        <div key={i} style={{ fontFamily: HAND, fontSize: 16, lineHeight: 1.15, color: r.author === 'AI' ? 'var(--o8ed-orange)' : 'var(--o8ed-ink-soft)', paddingLeft: 12, marginTop: 3 }}>
          ↳ {r.text}
        </div>
      ))}
      {isSuggestion && !resolved ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
          <NoteChip label="Accept" tone="add" onClick={() => onResolve(note, true)} />
          <NoteChip label="Dismiss" tone="muted" onClick={() => onResolve(note, false)} />
        </div>
      ) : null}
      {isComment && !resolved ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
          <NoteChip label="Resolve" tone="add" onClick={() => onResolveComment(note)} />
          <NoteChip label="Reply" tone="muted" onClick={() => setReplying((v) => !v)} />
        </div>
      ) : null}
      {replying ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitReply(); }
            if (e.key === 'Escape') { setReplying(false); setDraft(''); }
          }}
          placeholder="Reply…"
          style={{ marginTop: 5, width: '100%', fontFamily: HAND, fontSize: 16, lineHeight: 1.2, color: 'var(--o8ed-ink)', background: 'transparent', border: 'none', borderBottom: '1px solid var(--o8ed-ink-faint)', outline: 'none', paddingTop: 2, paddingBottom: 2 }}
        />
      ) : null}
    </div>
  );
}

function NoteChip({ label, tone, onClick }: { label: string; tone: 'add' | 'muted'; onClick: () => void }) {
  const color = tone === 'add' ? 'var(--o8ed-add)' : 'var(--o8ed-ink-faint)';
  return (
    <button type="button" onClick={onClick} style={{ cursor: 'pointer', fontFamily: PROSE, fontSize: 10.5, fontWeight: 350, letterSpacing: '-0.1px', color, background: 'transparent', border: `1px solid ${color}`, borderRadius: 6, paddingTop: 2, paddingBottom: 2, paddingLeft: 8, paddingRight: 8, filter: 'saturate(0.55)' }}>
      {label}
    </button>
  );
}
