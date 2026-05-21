'use client';

/*
 * O8SpecEditor — the real CodeMirror 6 inline editor for o8.md (roughdraft
 * Phase 4, model ③). You edit raw markdown; CriticMarkup review markers are
 * HIDDEN and rendered as inline marks in place:
 *   {==anchor==}            → highlighted anchor + ● note dot
 *   {>>comment<<}{meta}     → hidden (the text lives in the margin rail)
 *   {~~old~>new~~}{meta}    → old (strike) + new (green)
 *   {++text++}{meta}        → text (green, dotted underline)
 *   {--text--}{meta}        → text (red strike)
 * Heading `#` markers are hidden; markdown tokens get light syntax styling.
 *
 * Theme-agnostic: all colors come from --o8ed-* CSS vars the PARENT sets
 * (O8SpecPane maps them off --t-* tokens; the lab maps them off --lab-*).
 * Margin notes (the alive layer) + accept/reject render OUTSIDE this editor,
 * positioned against line geometry — wired by the parent in a later pass.
 */

import { useEffect, useRef } from 'react';
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

interface O8SpecEditorProps {
  value: string;
  onChange: (value: string) => void;
}

// ── note dot (marks where a comment was anchored) ──
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

const HIDE = Decoration.replace({});
const ARROW = Decoration.replace({ widget: new ArrowWidget() });
const DOT = Decoration.widget({ widget: new DotWidget(), side: 1 });
const styleMark = (css: string) => Decoration.mark({ attributes: { style: css } });
const HILITE_MARK = styleMark('background: var(--o8ed-hilite); border-radius: 3px; padding: 0 1px;');
const ADD_MARK = styleMark('color: var(--o8ed-add); text-decoration: underline dotted;');
const DEL_MARK = styleMark('color: var(--o8ed-del); text-decoration: line-through;');
const SUBOLD_MARK = styleMark('color: var(--o8ed-del); text-decoration: line-through; opacity: 0.85;');
const SUBNEW_MARK = styleMark('color: var(--o8ed-add);');

/** Scan the doc for CriticMarkup + heading markers and build the decoration set. */
function buildDeco(text: string): DecorationSet {
  const out: Range<Decoration>[] = [];
  const push = (from: number, to: number, deco: Decoration) => { if (to >= from) out.push(deco.range(from, to)); };

  // metadata blocks {id="…" by="…" …} — always hidden
  for (const m of text.matchAll(/\{(?:id|by|at|re|status|resolved)="[^"]*"(?:\s+[A-Za-z_]+="[^"]*")*\}/g)) {
    push(m.index!, m.index! + m[0].length, HIDE);
  }
  // highlight {==anchor==} → show anchor highlighted + a note dot
  for (const m of text.matchAll(/\{==([\s\S]*?)==\}/g)) {
    const start = m.index!; const innerStart = start + 3; const innerEnd = innerStart + m[1].length;
    push(start, innerStart, HIDE);
    push(innerStart, innerEnd, HILITE_MARK);
    push(innerEnd, start + m[0].length, HIDE);
    // no dot here — the comment that follows an anchor emits the dot, so an
    // anchored comment shows exactly one. (Standalone comments emit their own.)
  }
  // comment {>>…<<} → fully hidden (text lives in the margin); dot marks the spot
  for (const m of text.matchAll(/\{>>[\s\S]*?<<\}/g)) {
    push(m.index!, m.index!, DOT);
    push(m.index!, m.index! + m[0].length, HIDE);
  }
  // addition {++text++}
  for (const m of text.matchAll(/\{\+\+([\s\S]*?)\+\+\}/g)) {
    const start = m.index!; const innerStart = start + 3; const innerEnd = innerStart + m[1].length;
    push(start, innerStart, HIDE);
    push(innerStart, innerEnd, ADD_MARK);
    push(innerEnd, start + m[0].length, HIDE);
  }
  // deletion {--text--}
  for (const m of text.matchAll(/\{--([\s\S]*?)--\}/g)) {
    const start = m.index!; const innerStart = start + 3; const innerEnd = innerStart + m[1].length;
    push(start, innerStart, HIDE);
    push(innerStart, innerEnd, DEL_MARK);
    push(innerEnd, start + m[0].length, HIDE);
  }
  // substitution {~~old~>new~~}
  for (const m of text.matchAll(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g)) {
    const start = m.index!;
    const oldStart = start + 3; const oldEnd = oldStart + m[1].length;
    const newStart = oldEnd + 2; const newEnd = newStart + m[2].length;
    push(start, oldStart, HIDE);
    push(oldStart, oldEnd, SUBOLD_MARK);
    push(oldEnd, newStart, ARROW);
    push(newStart, newEnd, SUBNEW_MARK);
    push(newEnd, start + m[0].length, HIDE);
  }
  // heading markers `# ` → hidden (text styled by the highlight style)
  for (const m of text.matchAll(/^(#{1,6})\s+/gm)) {
    push(m.index!, m.index! + m[0].length, HIDE);
  }

  return Decoration.set(out, true);
}

const criticField = StateField.define<DecorationSet>({
  create: (state) => buildDeco(state.doc.toString()),
  update: (deco, tr) => (tr.docChanged ? buildDeco(tr.state.doc.toString()) : deco.map(tr.changes)),
  provide: (f) => EditorView.decorations.from(f),
});

// markdown token styling — clean "reading while editing" feel
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '21px', fontWeight: '600', color: 'var(--o8ed-ink)' },
  { tag: tags.heading2, fontSize: '12px', fontWeight: '600', color: 'var(--o8ed-ink-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  { tag: tags.heading3, fontSize: '14px', fontWeight: '600', color: 'var(--o8ed-ink-soft)' },
  { tag: tags.strong, fontWeight: '600', color: 'var(--o8ed-ink)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--o8ed-orange)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: "'SF Mono', Menlo, monospace", fontSize: '12.5px' },
  { tag: tags.list, color: 'var(--o8ed-ink)' },
]);

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--o8ed-ink)', height: '100%' },
  '.cm-scroller': { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '14.5px', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { paddingTop: '22px', paddingBottom: '26px', paddingLeft: '4px', caretColor: 'var(--o8ed-orange)' },
  '.cm-line': { paddingLeft: '0', paddingRight: '8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--o8ed-orange)', borderLeftWidth: '1.5px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--o8ed-hilite)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
});

export function O8SpecEditor({ value, onChange }: O8SpecEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // mount once
  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      syntaxHighlighting(mdHighlight),
      criticField,
      editorTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reconcile external value changes (load, agent annotation) without clobbering edits
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} style={{ height: '100%', overflow: 'hidden' }} />;
}
