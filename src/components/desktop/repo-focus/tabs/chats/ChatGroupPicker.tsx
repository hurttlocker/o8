'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { FilterList } from 'iconoir-react';
import { REPO_FOCUS_FONT } from '../../utils';

export type ChatGroupMode = 'repo' | 'date' | 'flat' | 'activity';

/** Group-by picker — vertical-sliders icon rendered inline at the
 *  right of the FIRST group header. Click opens a popover with three
 *  radio options: Repo / Date / Flat. Matches Claude's sidebar
 *  pattern from the operator's reference video. */
export function ChatGroupPicker({
  mode,
  onChange,
}: {
  mode: ChatGroupMode;
  onChange: (next: ChatGroupMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: globalThis.MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, marginRight: -1 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Change chat grouping"
        title="Change chat grouping"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          // Right-align the glyph so its right edge sits on the same
          // vertical column as the chat-row rings + chevrons in the
          // top-nav above (per operator's alignment ask).
          justifyContent: 'flex-end',
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 0,
          background: open || hovered ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          transition: 'background 120ms ease, color 120ms ease',
        }}
      >
        {/* Iconoir FilterList — matches hurttlocker chrome vocabulary. */}
        <FilterList width={12} height={12} color="currentColor" strokeWidth={1.8} />

      </button>
      {/* Always-mounted (display toggles) so agents can enumerate the
          grouping options from the DOM without opening first. */}
      <div
        id={menuId}
        role="menu"
        aria-label="Chat grouping options"
        style={{
            display: open ? 'block' : 'none',
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 168,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-panel)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            paddingTop: 4,
            paddingBottom: 4,
            zIndex: 50,
            fontFamily: REPO_FOCUS_FONT,
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          <ChatGroupPickerItem label="Group by repo" selected={mode === 'repo'} onClick={() => { onChange('repo'); setOpen(false); }} />
          <ChatGroupPickerItem label="Group by date" selected={mode === 'date'} onClick={() => { onChange('date'); setOpen(false); }} />
          <ChatGroupPickerItem label="Activity (priority first)" selected={mode === 'activity'} onClick={() => { onChange('activity'); setOpen(false); }} />
          <ChatGroupPickerItem label="Flat (no groups)" selected={mode === 'flat'} onClick={() => { onChange('flat'); setOpen(false); }} />
      </div>
    </div>
  );
}

function ChatGroupPickerItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12,
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: selected ? 'var(--t-accent)' : 'transparent',
        }}
      >
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <span>{label}</span>
    </button>
  );
}
