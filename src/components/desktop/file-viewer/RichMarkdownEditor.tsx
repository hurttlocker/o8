'use client';

import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { baseKeymap, chainCommands, newlineInCode, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import {
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { Mark } from 'prosemirror-model';
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from 'prosemirror-schema-list';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import 'prosemirror-view/style/prosemirror.css';
import {
  applyRichDocument,
  openRichDocument,
  richMarkdownSchema,
  UnsupportedMarkdownError,
} from '@/lib/markdown/editor';
import type { OpenRichDocumentResult } from '@/lib/markdown/editor/document';
import { serializeDocument } from '@/lib/markdown/transport';
import { richMarkdownNodeViews } from './rich-node-views';

const MonacoEditor = dynamic(() => import('@/lib/monaco-polyfills').then(() =>
  import('@monaco-editor/react').then((mod) => mod.default)
), {
  ssr: false,
  loading: () => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      fontSize: 13,
      color: 'var(--t-text-muted)',
    }}>
      Loading editor…
    </div>
  ),
});

export type MarkdownEditorMode = 'rich' | 'source';

export interface RichMarkdownEditorController {
  supported: boolean;
  mode: MarkdownEditorMode;
  document: OpenRichDocumentResult | null;
  unavailable: UnsupportedMarkdownError | null;
  selectMode: (mode: MarkdownEditorMode) => void;
  clearUnavailable: () => void;
  loadSource: (sourceKey: string, source: string) => void;
  reloadSource: (source: string) => void;
}

let sessionMarkdownMode: MarkdownEditorMode = 'source';

function supportsRichMarkdown(filePath: string): boolean {
  return /\.mdx?$/i.test(filePath);
}

export function useRichMarkdownEditor(
  filePath: string,
  source: string,
): RichMarkdownEditorController {
  const supported = supportsRichMarkdown(filePath);
  const [mode, setMode] = useState<MarkdownEditorMode>('source');
  const [document, setDocument] = useState<OpenRichDocumentResult | null>(null);
  const [unavailable, setUnavailable] = useState<UnsupportedMarkdownError | null>(null);
  const openedFileRef = useRef<string | null>(null);

  const openSource = useCallback((nextSource: string): boolean => {
    try {
      setDocument(openRichDocument(nextSource));
      setUnavailable(null);
      setMode('rich');
      return true;
    } catch (error) {
      if (!(error instanceof UnsupportedMarkdownError)) throw error;
      setDocument(null);
      setUnavailable(error);
      setMode('source');
      return false;
    }
  }, []);

  const selectMode = useCallback((nextMode: MarkdownEditorMode) => {
    if (!supported) return;
    if (nextMode === 'source') {
      sessionMarkdownMode = 'source';
      setMode('source');
      setDocument(null);
      setUnavailable(null);
      return;
    }
    if (openSource(source)) sessionMarkdownMode = 'rich';
  }, [openSource, source, supported]);

  const reloadSource = useCallback((nextSource: string) => {
    if (supported && mode === 'rich') {
      openSource(nextSource);
    } else {
      setDocument(null);
      setUnavailable(null);
    }
  }, [mode, openSource, supported]);

  const loadSource = useCallback((sourceKey: string, nextSource: string) => {
    if (openedFileRef.current === sourceKey) return;
    openedFileRef.current = sourceKey;
    setUnavailable(null);
    setDocument(null);
    if (!supported || sessionMarkdownMode === 'source') {
      setMode('source');
      return;
    }
    openSource(nextSource);
  }, [openSource, supported]);

  return {
    supported,
    mode,
    document,
    unavailable,
    selectMode,
    clearUnavailable: () => setUnavailable(null),
    loadSource,
    reloadSource,
  };
}

const toggleButtonStyle = {
  height: 26,
  paddingTop: 0,
  paddingRight: 10,
  paddingBottom: 0,
  paddingLeft: 10,
  border: 'none',
  borderRadius: 7,
  fontFamily: 'var(--font-sans-system)',
  fontSize: 11,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  cursor: 'pointer',
} as const;

export function MarkdownModeToggle({
  mode,
  onChange,
}: {
  mode: MarkdownEditorMode;
  onChange: (mode: MarkdownEditorMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Markdown editor mode"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 9,
        background: 'var(--t-panel)',
      }}
    >
      {(['rich', 'source'] as const).map((candidate) => {
        const active = mode === candidate;
        return (
          <button
            key={candidate}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(candidate)}
            style={{
              ...toggleButtonStyle,
              color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
              background: active ? 'var(--t-input-bg)' : 'transparent',
            }}
          >
            {candidate === 'rich' ? 'Rich' : 'Source'}
          </button>
        );
      })}
    </div>
  );
}

export function RichModeUnavailableStrip({ error }: { error: UnsupportedMarkdownError }) {
  return (
    <div style={{
      flexShrink: 0,
      paddingTop: 7,
      paddingRight: 20,
      paddingBottom: 7,
      paddingLeft: 20,
      borderBottom: '1px solid var(--t-divider-subtle)',
      background: 'var(--t-input-bg)',
      color: 'var(--t-text-muted)',
      fontFamily: 'var(--font-sans-system)',
      fontSize: 11,
      fontWeight: 300,
      letterSpacing: '-0.1px',
      lineHeight: 1.35,
    }}>
      Rich mode unavailable: {error.construct} at line {error.line}
    </div>
  );
}

interface LinkPopoverState {
  left: number;
  top: number;
  from: number;
  to: number;
  href: string;
  title: string | null;
  mark: Mark | null;
}

function activeLinkRange(view: EditorView, mark: Mark): { from: number; to: number } | null {
  const { $from } = view.state.selection;
  const parentStart = $from.start();
  const segments: Array<{ from: number; to: number }> = [];
  let segment: { from: number; to: number } | null = null;

  $from.parent.forEach((child, offset) => {
    const carriesLink = child.marks.some((candidate) => candidate.eq(mark));
    if (carriesLink) {
      if (!segment) segment = { from: offset, to: offset + child.nodeSize };
      else segment.to = offset + child.nodeSize;
    } else if (segment) {
      segments.push(segment);
      segment = null;
    }
  });
  if (segment) segments.push(segment);
  const match = segments.find(({ from, to }) => (
    $from.parentOffset >= from && $from.parentOffset <= to
  ));
  return match ? { from: parentStart + match.from, to: parentStart + match.to } : null;
}

type TestableEditorView = EditorView & { sourceChangeCount: number };

const richEditorViews = new WeakMap<Element, TestableEditorView>();

export function getRichMarkdownEditorView(element: Element): TestableEditorView | null {
  return richEditorViews.get(element) ?? null;
}

function hardBreakCommand(): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    dispatch(state.tr.replaceSelectionWith(richMarkdownSchema.nodes.hard_break.create()).scrollIntoView());
    return true;
  };
}

function toggleTaskCheckbox(view: EditorView, event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const checkbox = target.closest<HTMLInputElement>('input[data-task-checkbox="true"]');
  const itemDom = checkbox?.closest<HTMLElement>('li[data-task-checked]');
  if (!checkbox || !itemDom) return false;

  const $position = view.state.doc.resolve(view.posAtDOM(itemDom, 0));
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type !== richMarkdownSchema.nodes.list_item) continue;
    event.preventDefault();
    view.dispatch(view.state.tr.setNodeMarkup($position.before(depth), undefined, {
      ...node.attrs,
      checked: !node.attrs.checked,
    }));
    return true;
  }
  return false;
}

function editorPlugins(openLinkPopover: (view: EditorView) => boolean) {
  const { nodes, marks } = richMarkdownSchema;
  return [
    inputRules({
      rules: [
        textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({
          level: match[1].length,
        })),
        wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
        wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list, (match) => ({
          start: Number(match[1]),
        }), (match, node) => (
          node.childCount + Number(node.attrs.start) === Number(match[1])
        )),
        wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
        textblockTypeInputRule(/^```\s$/, nodes.code_block, { lang: null, meta: null }),
      ],
    }),
    history(),
    keymap({
      'Mod-b': toggleMark(marks.strong),
      'Mod-i': toggleMark(marks.em),
      'Mod-e': toggleMark(marks.code),
      'Mod-k': (_state, _dispatch, view) => view ? openLinkPopover(view) : false,
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      'Enter': splitListItem(nodes.list_item),
      'Shift-Enter': chainCommands(newlineInCode, hardBreakCommand()),
      'Tab': sinkListItem(nodes.list_item),
      'Shift-Tab': liftListItem(nodes.list_item),
    }),
    keymap(baseKeymap),
  ];
}

function RichMarkdownEditor({
  openDocument,
  onSourceChange,
}: {
  openDocument: OpenRichDocumentResult;
  onSourceChange: (source: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSourceChangeRef = useRef(onSourceChange);
  const [linkPopover, setLinkPopover] = useState<LinkPopoverState | null>(null);
  const [linkHref, setLinkHref] = useState('');

  useEffect(() => {
    onSourceChangeRef.current = onSourceChange;
  }, [onSourceChange]);

  const openLinkPopover = useCallback((view: EditorView) => {
    const { from, to, $from } = view.state.selection;
    const mark = richMarkdownSchema.marks.link.isInSet(
      view.state.storedMarks ?? $from.marks(),
    );
    const linkRange = from === to && mark ? activeLinkRange(view, mark) : null;
    const linkFrom = linkRange?.from ?? from;
    const linkTo = linkRange?.to ?? to;
    const coordinates = view.coordsAtPos(linkFrom);
    const bounds = containerRef.current?.getBoundingClientRect();
    const left = bounds ? Math.max(8, Math.min(coordinates.left - bounds.left, bounds.width - 272)) : 8;
    const top = bounds ? coordinates.bottom - bounds.top + 6 : 8;
    const href = typeof mark?.attrs.href === 'string' ? mark.attrs.href : '';
    setLinkHref(href);
    setLinkPopover({
      left,
      top,
      from: linkFrom,
      to: linkTo,
      href,
      title: typeof mark?.attrs.title === 'string' ? mark.attrs.title : null,
      mark: mark ?? null,
    });
    return true;
  }, []);

  useEffect(() => {
    if (!linkPopover) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [linkPopover]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let transport = openDocument.transport;
    const state = EditorState.create({
      schema: richMarkdownSchema,
      doc: openDocument.pmDoc,
      plugins: editorPlugins(openLinkPopover),
    });
    const view = new EditorView(mount, {
      state,
      attributes: {
        'aria-label': 'Rich Markdown editor',
        style: [
          'min-height:100%',
          'box-sizing:border-box',
          'outline:none',
          'padding:14px 20px 80px 20px',
          'font-family:var(--font-sans-system)',
          'color:var(--t-text)',
          'caret-color:var(--t-text)',
        ].join(';'),
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (!transaction.docChanged) return;
        transport = applyRichDocument(transport, nextState.doc);
        onSourceChangeRef.current(serializeDocument(transport));
        view.sourceChangeCount += 1;
      },
      nodeViews: richMarkdownNodeViews,
      handleDOMEvents: {
        click: toggleTaskCheckbox,
      },
    }) as TestableEditorView;
    view.sourceChangeCount = 0;
    viewRef.current = view;
    richEditorViews.set(mount, view);
    view.focus();

    return () => {
      richEditorViews.delete(mount);
      viewRef.current = null;
      view.destroy();
    };
  }, [openDocument, openLinkPopover]);

  const applyLink = useCallback(() => {
    const view = viewRef.current;
    if (!view || !linkPopover || !linkHref.trim()) return;
    const { from, to, title } = linkPopover;
    const link = richMarkdownSchema.marks.link;
    const mark = link.create({ href: linkHref.trim(), title });
    let transaction = view.state.tr;
    if (from === to) {
      const storedMarks = (view.state.storedMarks ?? view.state.selection.$from.marks())
        .filter((candidate) => candidate.type !== link);
      transaction = transaction.setStoredMarks([...storedMarks, mark]);
    } else {
      transaction = transaction.removeMark(from, to, link).addMark(from, to, mark);
    }
    view.dispatch(transaction.scrollIntoView());
    setLinkPopover(null);
    view.focus();
  }, [linkHref, linkPopover]);

  const removeLink = useCallback(() => {
    const view = viewRef.current;
    if (!view || !linkPopover) return;
    const link = richMarkdownSchema.marks.link;
    let transaction = view.state.tr;
    if (linkPopover.from === linkPopover.to) {
      transaction = transaction.setStoredMarks(
        (view.state.storedMarks ?? view.state.selection.$from.marks())
          .filter((candidate) => candidate.type !== link),
      );
    } else {
      transaction = transaction.removeMark(linkPopover.from, linkPopover.to, link);
    }
    view.dispatch(transaction.scrollIntoView());
    setLinkPopover(null);
    view.focus();
  }, [linkPopover]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: '100%',
        overflowY: 'auto',
        background: 'var(--t-editor-bg, var(--t-panel))',
      }}
    >
      <div ref={mountRef} data-rich-markdown-editor="true" style={{ minHeight: '100%' }} />
      {linkPopover ? (
        <div style={{
          position: 'absolute',
          left: linkPopover.left,
          top: linkPopover.top,
          zIndex: 20,
          width: 264,
          paddingTop: 8,
          paddingRight: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          border: '1px solid var(--t-divider-subtle)',
          borderRadius: 9,
          background: 'var(--t-panel-solid)',
          boxShadow: 'var(--t-shadow-popover)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}>
          <input
            ref={inputRef}
            aria-label="Link URL"
            value={linkHref}
            onChange={(event) => setLinkHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLink();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setLinkHref(linkPopover.href);
                setLinkPopover(null);
                viewRef.current?.focus();
              }
            }}
            placeholder="https://"
            style={{
              minWidth: 0,
              flex: 1,
              height: 26,
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              border: '1px solid var(--t-divider-subtle)',
              borderRadius: 7,
              outline: 'none',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 300,
            }}
          />
          <button
            type="button"
            onClick={applyLink}
            disabled={!linkHref.trim()}
            style={{
              ...toggleButtonStyle,
              color: 'var(--t-text)',
              background: 'var(--t-input-bg)',
              cursor: linkHref.trim() ? 'pointer' : 'default',
              opacity: linkHref.trim() ? 1 : 0.5,
            }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={removeLink}
            disabled={!linkPopover.mark}
            style={{
              ...toggleButtonStyle,
              paddingRight: 6,
              paddingLeft: 6,
              color: 'var(--t-text-muted)',
              background: 'transparent',
              cursor: linkPopover.mark ? 'pointer' : 'default',
              opacity: linkPopover.mark ? 1 : 0.5,
            }}
          >
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MarkdownEditorMount({
  controller,
  language,
  value,
  themeId,
  onSourceChange,
  onMonacoMount,
  beforeMonacoMount,
}: {
  controller: RichMarkdownEditorController;
  language: string;
  value: string;
  themeId: string;
  onSourceChange: (source: string) => void;
  onMonacoMount: (editor: unknown) => void;
  beforeMonacoMount: (monaco: typeof import('monaco-editor')) => void;
}) {
  if (controller.mode === 'rich' && controller.document) {
    return (
      <RichMarkdownEditor
        openDocument={controller.document}
        onSourceChange={onSourceChange}
      />
    );
  }

  return (
    <MonacoEditor
      height="100%"
      language={language}
      value={value}
      theme={themeId === 'light' ? 'cortex-frost' : 'cortex-graphite'}
      onChange={(nextValue) => {
        if (nextValue !== undefined) {
          controller.clearUnavailable();
          onSourceChange(nextValue);
        }
      }}
      onMount={onMonacoMount}
      beforeMount={beforeMonacoMount}
      options={{
        readOnly: false,
        fontSize: 13,
        fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
        lineHeight: 20,
        tabSize: 2,
        insertSpaces: true,
        minimap: { enabled: true, maxColumn: 80, scale: 2 },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        glyphMargin: false,
        folding: true,
        bracketPairColorization: { enabled: true },
        renderLineHighlight: 'line',
        occurrencesHighlight: 'singleFile',
        matchBrackets: 'always',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 12, bottom: 12 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        scrollbar: {
          vertical: 'hidden',
          horizontal: 'auto',
          verticalScrollbarSize: 0,
          horizontalScrollbarSize: 8,
          useShadows: false,
        },
        contextmenu: true,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false },
        inlineSuggest: { enabled: false },
        renderWhitespace: 'selection',
        guides: { bracketPairs: true, indentation: true },
      }}
    />
  );
}
