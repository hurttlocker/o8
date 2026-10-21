'use client';

import { CheckCircle2, MessageSquare } from '../lucide-shims';
import type { PrComposerMode } from './types';

const commands = [
  { id: 'comment', mode: 'comment' as const, label: 'Comment', description: 'Post a comment on this pull request', icon: MessageSquare },
  { id: 'review', mode: 'review' as const, label: 'Review', description: 'Comment, approve, or request changes', icon: CheckCircle2 },
];

export function matchingPrCommands(draft: string) {
  const query = draft.match(/^\/([a-z-]*)$/i)?.[1];
  return query === undefined ? null : commands.filter((command) => command.id.startsWith(query.toLowerCase()));
}

export function PrComposerCommands({ id, matches, selected, onSelect }: { id: string; matches: typeof commands; selected: number; onSelect: (mode: PrComposerMode) => void }) {
  return <div style={{ flexShrink: 0, paddingTop: 10, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, borderBottom: '1px solid var(--t-divider-subtle)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 0, paddingRight: 6, paddingBottom: 7, paddingLeft: 6, color: 'var(--t-text-muted)', fontSize: 10 }}><span>Pull request commands</span><span>↑ ↓ to choose · Enter</span></div>
    <div id={id} role="listbox" aria-label="Pull request commands" style={{ display: 'grid', gap: 3 }}>
      {matches.map((command, index) => <button key={command.id} id={`${id}-${command.id}`} role="option" aria-selected={index === selected} tabIndex={-1} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command.mode)} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 42, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, border: 0, borderRadius: 9, background: index === selected ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
        <command.icon size={16} aria-hidden="true" /><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 12 }}>{command.label}</span><span style={{ display: 'block', fontSize: 10, color: 'var(--t-text-muted)', marginTop: 2 }}>{command.description}</span></span><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>/{command.id}</span>
      </button>)}
    </div>
    {!matches.length ? <p role="status" style={{ margin: 6, fontSize: 11, color: 'var(--t-text-muted)' }}>No matching commands. Escape returns to Brain.</p> : null}
  </div>;
}
