'use client';

import { memo, type ReactNode } from 'react';
import {
  enterHintStyle,
  iconWrapStyle,
  metaTextStyle,
  rowStyleBase,
  sectionHeaderStyle,
  titleTextStyle,
  type GroupKey,
} from '../command-palette-styles';

export type PaletteIconKind =
  | 'issue'
  | 'file'
  | 'agent'
  | 'chat'
  | 'transcript'
  | 'approval'
  | 'inbox'
  | 'directive'
  | 'action';

export interface PaletteListItem {
  id: string;
  groupKey: GroupKey;
  title: string;
  meta: string;
  iconKind: PaletteIconKind;
  swatchColor?: string;
  highlight?: string;
}

const GROUP_LABEL: Record<GroupKey, string> = {
  recent: 'Recent',
  action: 'Actions',
  agent: 'Agents',
  file: 'Files',
  issue: 'Issues',
  chat: 'Conversations',
  transcript: 'Transcripts',
  approval: 'Approvals',
  inbox: 'Inbox',
  directive: 'Rules',
  recall: 'Recall',
};

export const PaletteList = memo(function PaletteList({
  items,
  selectedIndex,
  onHover,
  onActivate,
}: {
  items: PaletteListItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
}) {
  const sections: Array<{ key: GroupKey; start: number; entries: PaletteListItem[] }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const last = sections[sections.length - 1];
    if (!last || last.key !== item.groupKey) {
      sections.push({ key: item.groupKey, start: index, entries: [item] });
    } else {
      last.entries.push(item);
    }
  }

  return (
    <div role="listbox" aria-label="Search results" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {sections.map((section) => (
        <div key={`${section.key}:${section.start}`}>
          <div style={sectionHeaderStyle}>{GROUP_LABEL[section.key]}</div>
          {section.entries.map((item, offset) => {
            const flatIndex = section.start + offset;
            const active = flatIndex === selectedIndex;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={active}
                data-palette-index={flatIndex}
                onClick={() => onActivate(flatIndex)}
                onMouseEnter={() => onHover(flatIndex)}
                style={{
                  ...rowStyleBase,
                  background: active ? 'var(--t-panel-active)' : 'transparent',
                }}
              >
                <span style={iconWrapStyle}>
                  {item.swatchColor ? (
                    <span aria-hidden="true" style={{ width: 8, height: 8, display: 'inline-block', borderRadius: '50%', background: item.swatchColor }} />
                  ) : (
                    <PaletteKindGlyph kind={item.iconKind} />
                  )}
                </span>
                <span style={titleTextStyle}>{item.title}</span>
                {item.meta ? <span style={metaTextStyle}>{highlightMatch(item.meta, item.highlight)}</span> : null}
                <span aria-hidden="true" style={{ ...enterHintStyle, opacity: active ? 1 : 0 }}>↵</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});

function PaletteKindGlyph({ kind }: { kind: PaletteIconKind }) {
  const color = kind === 'issue'
    ? 'var(--t-brand-orange)'
    : kind === 'agent'
      ? 'var(--t-success)'
      : kind === 'chat'
        ? 'var(--t-accent)'
        : kind === 'transcript'
          ? 'var(--t-accent)'
          : kind === 'approval'
            ? 'var(--t-warning)'
            : kind === 'inbox'
              ? 'var(--t-brand-orange)'
        : kind === 'directive'
          ? 'var(--t-text-secondary)'
          : 'var(--t-text-muted)';

  if (kind === 'file') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
    );
  }
  if (kind === 'agent') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    );
  }
  if (kind === 'chat') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      </svg>
    );
  }
  if (kind === 'transcript') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3h12v18H6z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </svg>
    );
  }
  if (kind === 'approval') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
      </svg>
    );
  }
  if (kind === 'inbox') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4h16v14H4z" />
        <path d="M4 13h5l2 2h2l2-2h5" />
      </svg>
    );
  }
  if (kind === 'directive') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  if (kind === 'issue') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function highlightMatch(text: string, query?: string) {
  if (text.includes('\u0001') && text.includes('\u0002')) {
    let highlighted = false;
    return text.split(/([\u0001\u0002])/).reduce<ReactNode[]>((parts, segment, index) => {
      if (segment === '\u0001') {
        highlighted = true;
      } else if (segment === '\u0002') {
        highlighted = false;
      } else if (segment) {
        parts.push(highlighted
          ? <span key={`${index}:${segment}`} style={{ color: 'var(--t-accent)', fontWeight: 500 }}>{segment}</span>
          : segment);
      }
      return parts;
    }, []);
  }
  const needle = query?.trim();
  if (!needle) return text;
  const start = text.toLowerCase().indexOf(needle.toLowerCase());
  if (start < 0) return text;
  const end = start + needle.length;
  return (
    <>
      {text.slice(0, start)}
      <span style={{ color: 'var(--t-accent)', fontWeight: 500 }}>{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  );
}

export function SearchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function AlertGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
