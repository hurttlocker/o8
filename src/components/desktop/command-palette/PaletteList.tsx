'use client';

import { memo } from 'react';
import {
  enterHintStyle,
  iconWrapStyle,
  metaTextStyle,
  rowStyleBase,
  sectionHeaderStyle,
  titleTextStyle,
  type GroupKey,
} from '../command-palette-styles';

export type PaletteIconKind = 'issue' | 'file' | 'agent' | 'chat' | 'directive' | 'action';

export interface PaletteListItem {
  id: string;
  groupKey: GroupKey;
  title: string;
  meta: string;
  iconKind: PaletteIconKind;
  swatchColor?: string;
}

const GROUP_LABEL: Record<GroupKey, string> = {
  recent: 'Recent',
  action: 'Actions',
  agent: 'Agents',
  file: 'Files',
  issue: 'Issues',
  chat: 'Chats',
  directive: 'Rules',
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
                {item.meta ? <span style={metaTextStyle}>{item.meta}</span> : null}
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
