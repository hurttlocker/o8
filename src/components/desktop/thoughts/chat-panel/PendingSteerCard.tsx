'use client';

/**
 * PendingSteerCard — queued ⌘⏎ steers awaiting an idle agent.
 *
 * Renders nothing when the queue is empty. While a row is being inline-edited,
 * the consumer should pause auto-fire of the head (the queue pauses while a
 * row is being edited).
 *
 * Shape: stacked pending rows with Steer + Delete actions, plus inline edit.
 */

import { useEffect, useState } from 'react';

export type PendingSteer = {
  id: string;
  text: string;
};

type Props = {
  steers: PendingSteer[];
  /** Index of the steer focused via keyboard nav (null = composer has focus). Highlights the row. */
  focusedIndex?: number | null;
  /** When set, begin inline-editing this steer (keyboard E from the composer). */
  autoEditId?: string | null;
  /** Preempt: abort the running turn and fire this steer immediately. */
  onSteerNow: (id: string) => void;
  /** Discard a queued steer without firing. */
  onDelete: (id: string) => void;
  /** Commit an inline-edit. Consumer should treat any active edit as a pause on auto-fire of that row. */
  onEdit: (id: string, text: string) => void;
  /**
   * Notify the consumer that a row entered/left edit mode. Used to pause
   * auto-fire while the user is mid-edit on the head row.
   */
  onEditingChange?: (id: string | null) => void;
};

export function PendingSteerCard({
  steers,
  focusedIndex,
  autoEditId,
  onSteerNow,
  onDelete,
  onEdit,
  onEditingChange,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Keyboard E from the composer asks us to begin editing a specific row.
  useEffect(() => {
    if (!autoEditId || editingId === autoEditId) return;
    const target = steers.find((s) => s.id === autoEditId);
    if (!target) return;
    setEditingId(autoEditId);
    setDraft(target.text);
    onEditingChange?.(autoEditId);
  }, [autoEditId, editingId, steers, onEditingChange]);

  if (steers.length === 0) return null;

  function beginEdit(id: string, text: string) {
    setEditingId(id);
    setDraft(text);
    onEditingChange?.(id);
  }

  function endEdit() {
    setEditingId(null);
    onEditingChange?.(null);
  }

  function commitEdit(id: string) {
    onEdit(id, draft.trim());
    endEdit();
  }

  return (
    <div
      role="list"
      aria-label="Pending steers"
      style={{
        display: 'flex',
        flexDirection: 'column',
        marginTop: 0,
        marginRight: 12,
        marginBottom: 10,
        marginLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'var(--t-input-bg)',
        overflow: 'hidden',
      }}
    >
      {steers.map((steer, idx) => {
        const isEditing = editingId === steer.id;
        const isFirst = idx === 0;
        const isFocused = focusedIndex === idx;
        return (
          <SteerRow
            key={steer.id}
            steer={steer}
            isEditing={isEditing}
            isFirst={isFirst}
            isFocused={isFocused}
            draft={draft}
            setDraft={setDraft}
            onBeginEdit={() => beginEdit(steer.id, steer.text)}
            onCancelEdit={endEdit}
            onCommitEdit={() => commitEdit(steer.id)}
            onSteerNow={() => onSteerNow(steer.id)}
            onDelete={() => onDelete(steer.id)}
          />
        );
      })}
    </div>
  );
}

type RowProps = {
  steer: PendingSteer;
  isEditing: boolean;
  isFirst: boolean;
  isFocused: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onCommitEdit: () => void;
  onSteerNow: () => void;
  onDelete: () => void;
};

function SteerRow({
  steer,
  isEditing,
  isFirst,
  isFocused,
  draft,
  setDraft,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  onSteerNow,
  onDelete,
}: RowProps) {
  return (
    <div
      role="listitem"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 9,
        paddingRight: 8,
        paddingBottom: 9,
        paddingLeft: 12,
        borderTopWidth: isFirst ? 0 : 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider)',
        background: isFocused && !isEditing ? 'var(--t-hover)' : 'transparent',
        boxShadow: isFocused && !isEditing ? 'inset 2px 0 0 var(--t-accent)' : 'none',
      }}
    >
      {/* Branch-arrow icon — Codex pattern */}
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          color: 'var(--t-text-muted)',
          flexShrink: 0,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 3 v6 a3 3 0 0 0 3 3 h7" />
          <path d="M10 9 l3 3 -3 3" />
        </svg>
      </span>

      {/* Message text or inline editor */}
      {isEditing ? (
        <textarea
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onCommitEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          rows={1}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 20,
            maxHeight: 120,
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text)',
            fontSize: 13,
            fontFamily: 'var(--font-sans-system)',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.4,
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: 'var(--t-text)',
            fontSize: 13,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {steer.text}
        </span>
      )}

      {/* Right-edge actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {isEditing ? (
          <>
            <ActionButton label="Cancel" onClick={onCancelEdit}>
              <CrossIcon />
            </ActionButton>
            <ActionButton label="Save" onClick={onCommitEdit} accent>
              <CheckIcon />
            </ActionButton>
          </>
        ) : (
          <>
            <ActionButton label="Edit" onClick={onBeginEdit}>
              <PencilIcon />
            </ActionButton>
            <ActionButton label="Steer" onClick={onSteerNow} labeled>
              <SteerArrowIcon />
              <span style={{ fontSize: 12, marginLeft: 5 }}>Steer</span>
            </ActionButton>
            <ActionButton label="Delete" onClick={onDelete}>
              <TrashIcon />
            </ActionButton>
          </>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
  accent,
  labeled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  accent?: boolean;
  labeled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        width: labeled ? 'auto' : 26,
        paddingTop: 0,
        paddingRight: labeled ? 8 : 0,
        paddingBottom: 0,
        paddingLeft: labeled ? 7 : 0,
        borderWidth: 0,
        borderRadius: 7,
        background: hover ? 'var(--t-hover)' : 'transparent',
        color: accent ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.5 L13.5 4.5 L5.5 12.5 L3 13 L3.5 10.5 Z" />
    </svg>
  );
}

function SteerArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13 L12.5 3.5" />
      <path d="M6.5 3.5 H12.5 V9.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5 H13" />
      <path d="M5 5 V13 a1 1 0 0 0 1 1 H10 a1 1 0 0 0 1 -1 V5" />
      <path d="M6.5 5 V3.5 a1 1 0 0 1 1 -1 H8.5 a1 1 0 0 1 1 1 V5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5 L6.5 12 L13 4" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4 L12 12" />
      <path d="M12 4 L4 12" />
    </svg>
  );
}
