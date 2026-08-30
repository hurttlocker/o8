'use client';

import { useEffect, useState } from 'react';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { richMarkdownSchema } from '@/lib/markdown/editor';

type SlashCommandId =
  | 'heading'
  | 'bullet-list'
  | 'numbered-list'
  | 'task-list'
  | 'code-fence'
  | 'table'
  | 'quote'
  | 'divider';

interface SlashCommand {
  id: SlashCommandId;
  label: string;
  description: string;
  terms: readonly string[];
}

interface SlashPrompt {
  blockFrom: number;
  blockTo: number;
  caret: number;
  key: string;
  query: string;
  commandIds: SlashCommandId[];
}

interface SlashMenuState {
  prompt: SlashPrompt | null;
  selectedIndex: number;
  dismissedKey: string | null;
}

type SlashMenuMeta = { type: 'move'; delta: number } | { type: 'dismiss' };

const slashCommands: readonly SlashCommand[] = [
  {
    id: 'heading',
    label: 'Heading',
    description: 'Section heading',
    terms: ['heading', 'title'],
  },
  {
    id: 'bullet-list',
    label: 'Bullet list',
    description: 'Unordered list',
    terms: ['bullet', 'list', 'unordered'],
  },
  {
    id: 'numbered-list',
    label: 'Numbered list',
    description: 'Ordered list',
    terms: ['numbered', 'ordered', 'list'],
  },
  {
    id: 'task-list',
    label: 'Task list',
    description: 'Unchecked task',
    terms: ['task', 'todo', 'checkbox', 'list'],
  },
  {
    id: 'code-fence',
    label: 'Code fence',
    description: 'Fenced code block',
    terms: ['code', 'fence', 'block'],
  },
  {
    id: 'table',
    label: 'Table',
    description: 'Two-column table',
    terms: ['table', 'grid'],
  },
  {
    id: 'quote',
    label: 'Quote',
    description: 'Block quote',
    terms: ['quote', 'blockquote'],
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Horizontal rule',
    terms: ['divider', 'rule', 'separator'],
  },
];

const commandById = new Map(slashCommands.map((command) => [command.id, command]));
const slashMenuKey = new PluginKey<SlashMenuState>('rich-markdown-slash-menu');
const slashMenuListeners = new WeakMap<EditorView, Set<(state: SlashMenuState) => void>>();

const closedSlashMenuState: SlashMenuState = {
  prompt: null,
  selectedIndex: 0,
  dismissedKey: null,
};

function matchingCommandIds(query: string): SlashCommandId[] {
  if (!query) return slashCommands.map((command) => command.id);
  return slashCommands.flatMap((command) => (
    command.label.toLocaleLowerCase().includes(query)
    || command.terms.some((term) => term.startsWith(query))
      ? [command.id]
      : []
  ));
}

function slashPrompt(state: EditorState): SlashPrompt | null {
  const { $from } = state.selection;
  if (
    !state.selection.empty
    || $from.depth !== 1
    || $from.parent.type !== richMarkdownSchema.nodes.paragraph
  ) {
    return null;
  }
  const textBeforeCaret = $from.parent.textBetween(0, $from.parentOffset, '\u0000', '\u0000');
  const match = /^\/([a-z]*)$/i.exec(textBeforeCaret);
  if (!match) return null;
  const query = match[1].toLocaleLowerCase();
  const commandIds = matchingCommandIds(query);
  if (commandIds.length === 0) return null;
  const blockFrom = $from.before(1);
  return {
    blockFrom,
    blockTo: $from.after(1),
    caret: state.selection.from,
    key: `${blockFrom}:${textBeforeCaret}`,
    query,
    commandIds,
  };
}

function samePrompt(left: SlashPrompt | null, right: SlashPrompt): boolean {
  return Boolean(
    left
    && left.key === right.key
    && left.caret === right.caret
    && left.commandIds.length === right.commandIds.length
    && left.commandIds.every((id, index) => id === right.commandIds[index]),
  );
}

function paragraph(text?: string): ProseMirrorNode {
  return richMarkdownSchema.nodes.paragraph.createChecked(
    null,
    text ? richMarkdownSchema.text(text) : null,
  );
}

function list(ordered: boolean, checked: boolean | null): ProseMirrorNode {
  const item = richMarkdownSchema.nodes.list_item.createChecked(
    { checked },
    paragraph(checked === false ? 'Task' : 'List item'),
  );
  return (ordered
    ? richMarkdownSchema.nodes.ordered_list
    : richMarkdownSchema.nodes.bullet_list
  ).createChecked(ordered ? { start: 1 } : null, item);
}

function blockForCommand(id: SlashCommandId): ProseMirrorNode {
  switch (id) {
    case 'heading':
      return richMarkdownSchema.nodes.heading.createChecked({ level: 1 });
    case 'bullet-list':
      return list(false, null);
    case 'numbered-list':
      return list(true, null);
    case 'task-list':
      return list(false, false);
    case 'code-fence':
      return richMarkdownSchema.nodes.code_block.createChecked({ lang: null, meta: null });
    case 'table':
      return richMarkdownSchema.nodes.table.createChecked();
    case 'quote':
      return richMarkdownSchema.nodes.blockquote.createChecked(null, paragraph('Quote'));
    case 'divider':
      return richMarkdownSchema.nodes.horizontal_rule.createChecked();
  }
}

function insertSlashBlock(view: EditorView, id: SlashCommandId): void {
  const menuState = slashMenuKey.getState(view.state);
  const prompt = menuState?.prompt;
  if (!prompt || !prompt.commandIds.includes(id)) return;

  const node = blockForCommand(id);
  let transaction = view.state.tr.replaceWith(prompt.blockFrom, prompt.blockTo, node);
  if (id === 'table' || id === 'divider') {
    transaction = transaction.setSelection(NodeSelection.create(transaction.doc, prompt.blockFrom));
  } else if (id === 'task-list' || id === 'bullet-list' || id === 'numbered-list') {
    const placeholderLength = id === 'task-list' ? 4 : 9;
    transaction = transaction.setSelection(TextSelection.create(
      transaction.doc,
      prompt.blockFrom + 3,
      prompt.blockFrom + 3 + placeholderLength,
    ));
  } else if (id === 'quote') {
    transaction = transaction.setSelection(TextSelection.create(
      transaction.doc,
      prompt.blockFrom + 2,
      prompt.blockFrom + 7,
    ));
  } else {
    transaction = transaction.setSelection(TextSelection.near(
      transaction.doc.resolve(prompt.blockFrom + 1),
    ));
  }
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

function publishSlashMenuState(view: EditorView): void {
  const state = slashMenuKey.getState(view.state) ?? closedSlashMenuState;
  slashMenuListeners.get(view)?.forEach((listener) => listener(state));
}

export const richMarkdownSlashMenuPlugin = new Plugin<SlashMenuState>({
  key: slashMenuKey,
  state: {
    init: (_config, state) => {
      const prompt = slashPrompt(state);
      return prompt ? { prompt, selectedIndex: 0, dismissedKey: null } : closedSlashMenuState;
    },
    apply: (transaction, previous, _oldState, nextState) => {
      const meta = transaction.getMeta(slashMenuKey) as SlashMenuMeta | undefined;
      if (meta?.type === 'dismiss' && previous.prompt) {
        return { prompt: null, selectedIndex: 0, dismissedKey: previous.prompt.key };
      }
      if (meta?.type === 'move' && previous.prompt) {
        const count = previous.prompt.commandIds.length;
        return {
          ...previous,
          selectedIndex: ((previous.selectedIndex + meta.delta) % count + count) % count,
        };
      }

      const prompt = slashPrompt(nextState);
      if (!prompt) return previous === closedSlashMenuState ? previous : closedSlashMenuState;
      if (prompt.key === previous.dismissedKey) {
        return previous.prompt === null ? previous : {
          prompt: null,
          selectedIndex: 0,
          dismissedKey: prompt.key,
        };
      }
      if (samePrompt(previous.prompt, prompt)) return previous;
      return { prompt, selectedIndex: 0, dismissedKey: null };
    },
  },
  props: {
    handleKeyDown: (view, event) => {
      const state = slashMenuKey.getState(view.state);
      if (!state?.prompt) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        view.dispatch(view.state.tr.setMeta(slashMenuKey, {
          type: 'move',
          delta: event.key === 'ArrowDown' ? 1 : -1,
        } satisfies SlashMenuMeta));
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        insertSlashBlock(view, state.prompt.commandIds[state.selectedIndex]);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        view.dispatch(view.state.tr.setMeta(slashMenuKey, {
          type: 'dismiss',
        } satisfies SlashMenuMeta));
        return true;
      }
      return false;
    },
  },
  view: (view) => ({
    update: (nextView, previousState) => {
      if (slashMenuKey.getState(nextView.state) !== slashMenuKey.getState(previousState)) {
        publishSlashMenuState(nextView);
      }
    },
    destroy: () => {
      slashMenuListeners.delete(view);
    },
  }),
});

function subscribeToSlashMenu(
  view: EditorView,
  listener: (state: SlashMenuState) => void,
): () => void {
  const listeners = slashMenuListeners.get(view) ?? new Set<(state: SlashMenuState) => void>();
  listeners.add(listener);
  slashMenuListeners.set(view, listeners);
  listener(slashMenuKey.getState(view.state) ?? closedSlashMenuState);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) slashMenuListeners.delete(view);
  };
}

export function RichMarkdownSlashMenu({
  view,
  container,
}: {
  view: EditorView | null;
  container: HTMLDivElement | null;
}) {
  const [menuState, setMenuState] = useState<SlashMenuState>(closedSlashMenuState);

  useEffect(() => {
    if (!view) return undefined;
    return subscribeToSlashMenu(view, setMenuState);
  }, [view]);

  if (!view || !container || !menuState.prompt) return null;
  const coordinates = view.coordsAtPos(menuState.prompt.caret);
  const bounds = container.getBoundingClientRect();
  const left = Math.max(8, Math.min(coordinates.left - bounds.left, bounds.width - 268));
  const top = coordinates.bottom - bounds.top + container.scrollTop + 6;

  return (
    <div
      role="listbox"
      aria-label="Insert Markdown block"
      style={{
        position: 'absolute',
        left,
        top,
        zIndex: 20,
        width: 260,
        maxHeight: 360,
        overflowY: 'auto',
        paddingTop: 4,
        paddingRight: 4,
        paddingBottom: 4,
        paddingLeft: 4,
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 9,
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow)',
      }}
    >
      {menuState.prompt.commandIds.map((id, index) => {
        const command = commandById.get(id)!;
        const active = index === menuState.selectedIndex;
        return (
          <button
            key={id}
            type="button"
            role="option"
            aria-selected={active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertSlashBlock(view, id)}
            style={{
              display: 'flex',
              width: '100%',
              minHeight: 44,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              border: 'none',
              borderRadius: 7,
              background: active ? 'var(--t-input-bg)' : 'transparent',
              color: 'var(--t-text)',
              fontFamily: 'var(--font-sans-system)',
              textAlign: 'left',
              cursor: 'pointer',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 400, lineHeight: 1.2 }}>
              {command.label}
            </span>
            <span style={{
              marginTop: 2,
              color: 'var(--t-text-muted)',
              fontSize: 10,
              fontWeight: 300,
              lineHeight: 1.2,
            }}>
              {command.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
