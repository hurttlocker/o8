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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { EditorState, StateField, StateEffect, Annotation, type Extension, type Range } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { extractRoughdraftReviewIndex } from '@/lib/o8md/rfm';
import { handleImagePathsViaTauri, specImageDropPaste } from './spec-image-upload';
import { specImageRender, specRepoPathCompartment, specRepoPathFacet } from './spec-image-widget';
import { useTauriFileDrop } from '@/lib/hooks/use-tauri-file-drop';

const HAND = "'Caveat', ui-rounded, cursive";
const PROSE = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, system-ui, sans-serif";
// Note rail width. Kept tight (was 220 — too wide, notes read "detached" floating
// in an empty band) so each margin note sits close to the prose it annotates,
// matching the o8-site reference (~116px note + ~10px gap). (2026-07-02)
const RAIL_W = 150;

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
  /** Adopt content written synchronously by a per-note server action without
   * scheduling a duplicate debounced PUT. */
  onServerMutation?: (value: string) => void;
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
  { tag: tags.heading1, fontSize: 'calc(18px * var(--spec-scale, 1))', fontWeight: '400', letterSpacing: '-0.2px', color: 'var(--o8ed-ink)' },
  { tag: tags.heading2, fontSize: 'calc(10px * var(--spec-scale, 1))', fontWeight: '300', color: 'var(--o8ed-ink-faint)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  { tag: tags.heading3, fontSize: 'calc(13.5px * var(--spec-scale, 1))', fontWeight: '400', letterSpacing: '-0.1px', color: 'var(--o8ed-ink-soft)' },
  { tag: tags.strong, fontWeight: '500', color: 'var(--o8ed-ink)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--o8ed-orange)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: "'SF Mono', Menlo, monospace", fontSize: 'calc(12px * var(--spec-scale, 1))' },
]);

// height:auto + scroller overflow visible → the editor grows to content so the
// PARENT scrolls; margin notes positioned in the same (scroll-shared) space.
const editorTheme = EditorView.theme({
  // --spec-scale: 1 on the dashboard; on the canvas it's the canvas zoom, so the
  // editor renders at device 1:1 (caret hit-testing works) but its type/padding
  // shrink to match the scaled card. lineHeight stays unitless (scales w/ font).
  '&': { backgroundColor: 'transparent', color: 'var(--o8ed-ink)', height: 'auto' },
  '.cm-scroller': { fontFamily: PROSE, fontSize: 'calc(13.5px * var(--spec-scale, 1))', fontWeight: '300', letterSpacing: '-0.1px', lineHeight: '1.55', overflow: 'visible' },
  '.cm-content': { paddingTop: 'calc(22px * var(--spec-scale, 1))', paddingBottom: 'calc(26px * var(--spec-scale, 1))', paddingLeft: 'calc(4px * var(--spec-scale, 1))', caretColor: 'var(--o8ed-orange)' },
  '.cm-line': { paddingLeft: '0', paddingRight: 'calc(8px * var(--spec-scale, 1))' },
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
  anchorText?: string;
  status: string | null;
  offset: number;
  endOffset: number;
  replies: { author: string | null; text: string }[];
  top: number;
}

export function O8SpecEditor({ value, onChange, onServerMutation, repoPath }: O8SpecEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Kept in a ref so the (mount-once) image extension always reads the live repo
  // path without rebuilding the editor when the operator switches repos.
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;

  // Tauri's drag-drop bridge — Finder→app drops are intercepted by Tauri
  // (dragDropEnabled: true) so the CodeMirror HTML5 `drop` extension below
  // never sees them in the prod app. Subscribe to the Rust-side bridge here
  // and upload via the `?srcPath=` ingest path on /api/repo-spec/asset.
  // Paste keeps working through the native webview paste event.
  useTauriFileDrop({
    hostRef,
    onDrop: (paths, coords) => {
      const repo = repoPathRef.current;
      const view = viewRef.current;
      if (!repo || !view) return;
      const pos = view.posAtCoords({ x: coords.x, y: coords.y }) ?? view.state.selection.main.head;
      handleImagePathsViaTauri(view, repo, pos, paths);
    },
  });

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
  // Measured pixel heights of the rendered notes, keyed by id. The collision
  // reserve uses these (exact) rather than a char-count estimate — the estimate
  // assumed a fixed chars-per-line and broke when the rail narrowed (fewer
  // chars/line → taller notes → under-reserved → overlap at the top on load). A
  // note reports its real height via a ref callback below. (2026-07-02)
  const noteHeightsRef = useRef<Map<string, number>>(new Map());
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
          originalText: i.originalText, replacementText: i.replacementText, anchorText: i.anchorText, status: i.status,
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
      // Prefer the MEASURED note height (exact, includes wrapping + padding).
      // Fall back to a width-aware estimate only until a note has been measured
      // once — chars-per-line is derived from the current rail width so it tracks
      // RAIL_W instead of assuming a fixed 24.
      const cpl = Math.max(8, Math.floor((RAIL_W - 34) / 7));
      const lines = Math.max(1, Math.ceil((n.text?.length ?? 0) / cpl));
      const estFallback = 24 + lines * 22 + n.replies.length * 22 + (n.kind === 'suggestion' ? 26 : 0);
      const est = noteHeightsRef.current.get(n.id) ?? estFallback;
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

  const postNoteAction = useCallback(async (
    action: 'scoped-reply' | 'apply-suggestion' | 'resolve',
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const view = viewRef.current;
    if (!view || !repoPath) throw new Error('Select a repo before acting on a note.');
    const response = await fetch(`/api/repo-spec?action=${action}&repoPath=${encodeURIComponent(repoPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, content: view.state.doc.toString() }),
    });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || data?.ok !== true) {
      throw new Error(typeof data?.error === 'string' ? data.error : 'Note action failed.');
    }
    if (typeof data.content === 'string') onServerMutation?.(data.content);
    return data;
  }, [onServerMutation, repoPath]);

  const resolveSuggestion = useCallback(async (note: NoteLayout, accept: boolean) => {
    await postNoteAction('apply-suggestion', { targetId: note.id, accept });
    return accept ? 'Applied to o8.md.' : 'Suggestion dismissed.';
  }, [postNoteAction]);

  const resolveComment = useCallback(async (note: NoteLayout) => {
    await postNoteAction('resolve', { targetId: note.id });
    return 'Thread resolved.';
  }, [postNoteAction]);

  const replyToNote = useCallback(async (note: NoteLayout, message: string) => {
    const text = message.trim();
    if (!text) throw new Error('Write a reply first.');
    await postNoteAction('scoped-reply', { parentId: note.id, message: text });
    return 'o8 replied to this note.';
  }, [postNoteAction]);

  const actOnNote = useCallback(async (note: NoteLayout) => {
    if (!repoPath) throw new Error('Select a repo before acting on a note.');
    const anchor = note.anchorText ?? note.originalText ?? '(no literal anchor)';
    const prompt = [
      'Carry out this accepted o8.md annotation as one scoped action. Do not rerun the full o8.md review or regenerate other annotations.',
      '',
      `Annotation: ${note.text || 'Suggested edit'}`,
      `Anchor: ${anchor}`,
      '',
      'Use the repository state to decide the concrete action. If the note recommends tracking work, file the appropriate ticket. If it recommends a code or documentation change, implement and verify that change. Keep the work limited to this annotation.',
    ].join('\n');
    const response = await fetch('/api/orchestrator/delegate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath,
        prompt,
        taskName: `Act on o8.md note ${note.id}`,
      }),
    });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    const awaitingApproval = response.status === 202 && typeof data?.approvalId === 'string';
    if ((!response.ok || data?.ok !== true) && !awaitingApproval) {
      throw new Error(
        typeof data?.error === 'string'
          ? data.error
          : typeof data?.note === 'string'
            ? data.note
            : 'Unable to dispatch this note.',
      );
    }
    const actionId = awaitingApproval && typeof data?.approvalId === 'string'
      ? data.approvalId
      : typeof data?.packetId === 'string'
        ? data.packetId
        : 'scoped action';
    await postNoteAction('resolve', {
      targetId: note.id,
      summary: awaitingApproval ? `Accepted; awaiting approval ${actionId}` : `Accepted; dispatched ${actionId}`,
    });
    return awaitingApproval ? 'Action is awaiting approval.' : `Action dispatched as ${actionId}.`;
  }, [postNoteAction, repoPath]);

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
          style={{ position: 'absolute', top: n.top - 3, right: 0, width: RAIL_W - 16 }}
        >
          {/* Inner hover-card — tinting on hover ties the note to the reader's
              focus; wrapped separately so framer-motion keeps owning transform. */}
          <div
            ref={(el) => {
              if (!el) return;
              const h = el.offsetHeight;
              const prev = noteHeightsRef.current.get(n.id);
              // Feed the real height back so the collision reserve is exact. Only
              // re-run when it actually changed (>1px) so this can't loop.
              if (prev === undefined || Math.abs(prev - h) > 1) {
                noteHeightsRef.current.set(n.id, h);
                scheduleRecomputeRef.current();
              }
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--o8ed-ink-soft) 8%, transparent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            style={{ paddingTop: 3, paddingBottom: 4, paddingLeft: 14, paddingRight: 6, borderRadius: 9, backgroundColor: 'transparent', transition: 'background-color 140ms ease' }}
          >
            <MarginNote
              note={n}
              onResolve={resolveSuggestion}
              onResolveComment={resolveComment}
              onReply={replyToNote}
              onAct={actOnNote}
            />
          </div>
        </motion.div>
      ))}
    </div>
  );
}

type NoteAction = 'reply' | 'apply' | 'dismiss' | 'resolve' | 'act';

function MarginNote({ note, onResolve, onResolveComment, onReply, onAct }: {
  note: NoteLayout;
  onResolve: (n: NoteLayout, accept: boolean) => Promise<string>;
  onResolveComment: (n: NoteLayout) => Promise<string>;
  onReply: (n: NoteLayout, message: string) => Promise<string>;
  onAct: (n: NoteLayout) => Promise<string>;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<NoteAction | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const isAI = note.author === 'AI';
  const ink = isAI ? 'var(--o8ed-orange)' : 'var(--o8ed-ink-soft)';
  const resolved = note.status === 'resolved';
  const isSuggestion = note.kind === 'suggestion';
  const isComment = note.kind === 'comment';
  const runAction = async (action: NoteAction, operation: () => Promise<string>): Promise<boolean> => {
    if (pending) return false;
    setPending(action);
    setFeedback(null);
    try {
      const message = await operation();
      setFeedback({ tone: 'ok', text: message });
      return true;
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Note action failed.' });
      return false;
    } finally {
      setPending(null);
    }
  };
  const submitReply = async () => {
    const sent = await runAction('reply', () => onReply(note, draft));
    if (sent) {
      setDraft('');
      setReplying(false);
    }
  };
  return (
    <div style={{ opacity: resolved ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 12, height: 0, borderTop: '1px dotted var(--o8ed-ink-faint)', flexShrink: 0, marginLeft: -14 }} />
        <span style={{ fontFamily: PROSE, fontSize: 9, fontWeight: 300, letterSpacing: '0.05em', textTransform: 'uppercase', color: isAI ? 'var(--o8ed-orange)' : 'var(--o8ed-ink-faint)' }}>
          {isAI ? 'o8' : 'you'}
        </span>
        {resolved ? <span style={{ fontFamily: PROSE, fontSize: 9, color: 'var(--o8ed-ink-faint)' }}>resolved</span> : null}
      </div>
      <div style={{ fontFamily: HAND, fontSize: 'calc(18px * var(--o8ed-note-scale, 1))', lineHeight: 1.15, color: ink, textDecoration: resolved ? 'line-through' : 'none' }}>
        {isSuggestion && !note.text ? 'suggested edit' : note.text}
      </div>
      {note.replies.map((r, i) => (
        <div key={i} style={{ fontFamily: HAND, fontSize: 'calc(16px * var(--o8ed-note-scale, 1))', lineHeight: 1.15, color: r.author === 'AI' ? 'var(--o8ed-orange)' : 'var(--o8ed-ink-soft)', paddingLeft: 12, marginTop: 3 }}>
          ↳ {r.text}
        </div>
      ))}
      {isSuggestion && !resolved ? (
        <NoteActionRow
          pending={pending}
          actions={[
            { key: 'apply', label: 'Accept & apply', tone: 'add', icon: ICON_APPLY, onClick: () => { void runAction('apply', () => onResolve(note, true)); } },
            { key: 'act', label: 'Accept & act', tone: 'add', icon: ICON_ACT, onClick: () => { void runAction('act', () => onAct(note)); } },
            { key: 'reply', label: 'Reply', tone: 'muted', icon: ICON_REPLY, onClick: () => setReplying((v) => !v) },
            { key: 'dismiss', label: 'Dismiss', tone: 'muted', icon: ICON_DISMISS, onClick: () => { void runAction('dismiss', () => onResolve(note, false)); } },
          ]}
        />
      ) : null}
      {isComment && !resolved ? (
        <NoteActionRow
          pending={pending}
          actions={[
            { key: 'reply', label: 'Reply', tone: 'muted', icon: ICON_REPLY, onClick: () => setReplying((v) => !v) },
            { key: 'act', label: 'Accept & act', tone: 'add', icon: ICON_ACT, onClick: () => { void runAction('act', () => onAct(note)); } },
            { key: 'resolve', label: 'Resolve', tone: 'muted', icon: ICON_RESOLVE, onClick: () => { void runAction('resolve', () => onResolveComment(note)); } },
          ]}
        />
      ) : null}
      {feedback ? (
        <div style={{ marginTop: 5, fontFamily: PROSE, fontSize: 9.5, fontWeight: 300, lineHeight: 1.3, color: feedback.tone === 'error' ? 'var(--o8ed-del)' : 'var(--o8ed-add)' }}>
          {feedback.text}
        </div>
      ) : null}
      {replying ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void submitReply(); }
            if (e.key === 'Escape') { setReplying(false); setDraft(''); }
          }}
          placeholder="Reply…"
          disabled={pending !== null}
          style={{ marginTop: 5, width: '100%', fontFamily: HAND, fontSize: 'calc(16px * var(--o8ed-note-scale, 1))', lineHeight: 1.2, color: 'var(--o8ed-ink)', background: 'transparent', border: 'none', borderBottom: '1px solid var(--o8ed-ink-faint)', outline: 'none', paddingTop: 2, paddingBottom: 2 }}
        />
      ) : null}
    </div>
  );
}

// Icon-only note actions (operator ruling 2026-07-31): the bordered full-text
// chips at 44px minimums stacked into giant pills inside the 150px rail, so
// this surface deliberately trades the HIG touch minimum for rail density —
// 22px icon targets, with the hovered/busy action spelled out in a fixed
// label line so nothing shifts on hover.
const NOTE_ICON = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ICON_REPLY = <svg width={14} height={14} viewBox="0 0 24 24" {...NOTE_ICON}><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>;
const ICON_APPLY = <svg width={14} height={14} viewBox="0 0 24 24" {...NOTE_ICON}><polyline points="20 6 9 17 4 12" /></svg>;
const ICON_ACT = <svg width={14} height={14} viewBox="0 0 24 24" {...NOTE_ICON}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>;
const ICON_DISMISS = <svg width={14} height={14} viewBox="0 0 24 24" {...NOTE_ICON}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
const ICON_RESOLVE = <svg width={14} height={14} viewBox="0 0 24 24" {...NOTE_ICON}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.27" /></svg>;

function NoteActionRow({ actions, pending }: {
  actions: Array<{ key: NoteAction; label: string; tone: 'add' | 'muted'; icon: ReactNode; onClick: () => void }>;
  pending: NoteAction | null;
}) {
  const [hovered, setHovered] = useState<NoteAction | null>(null);
  const activeKey = pending ?? hovered;
  const active = activeKey ? actions.find((a) => a.key === activeKey) ?? null : null;
  return (
    <div style={{ marginTop: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onMouseLeave={() => setHovered(null)}>
        {actions.map((a) => {
          const color = a.tone === 'add' ? 'var(--o8ed-add)' : 'var(--o8ed-ink-faint)';
          const lit = hovered === a.key || pending === a.key;
          return (
            <button
              key={a.key}
              type="button"
              title={a.label}
              onClick={a.onClick}
              disabled={pending !== null}
              onMouseEnter={() => setHovered(a.key)}
              style={{ cursor: pending !== null ? 'default' : 'pointer', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color, opacity: pending !== null && pending !== a.key ? 0.35 : lit ? 1 : 0.7, backgroundColor: 'transparent', borderWidth: 0, borderStyle: 'none', padding: 0, filter: 'saturate(0.55)', transition: 'opacity 120ms ease' }}
            >
              {a.icon}
            </button>
          );
        })}
      </div>
      <div style={{ height: 13, fontFamily: PROSE, fontSize: 9, fontWeight: 350, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: '13px', color: active ? (active.tone === 'add' ? 'var(--o8ed-add)' : 'var(--o8ed-ink-faint)') : 'transparent', filter: 'saturate(0.55)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {active ? (pending === active.key ? `${active.label}…` : active.label) : ''}
      </div>
    </div>
  );
}
