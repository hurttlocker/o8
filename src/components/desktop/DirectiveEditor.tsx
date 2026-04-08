'use client';

/**
 * DirectiveEditor -- Inline editor pane for a single directive.
 *
 * Extracted from DirectivesView to stay under the 800-line ceiling.
 * Title, scope, priority, markdown body, token count, save/delete actions.
 */

import { forwardRef, useCallback, useState } from 'react';
import type { DirectiveScope } from '@/lib/cortex/directives-types';
import { TrashIcon, FloppyIcon } from '@/components/desktop/directives-icons';

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Shared input focus/blur handlers ──

function onInputFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = 'var(--t-accent)';
  e.currentTarget.style.boxShadow = '0 0 0 2px var(--t-accent-ring)';
}

function onInputBlur(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = 'var(--t-input-border)';
  e.currentTarget.style.boxShadow = 'none';
}

const INPUT_BASE = {
  width: '100%',
  paddingTop: 7,
  paddingRight: 10,
  paddingBottom: 7,
  paddingLeft: 10,
  borderRadius: 8,
  border: '1px solid var(--t-input-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 13,
  fontFamily: 'system-ui, sans-serif',
  letterSpacing: '-0.01em',
  outline: 'none',
  boxSizing: 'border-box' as const,
};

const LABEL_STYLE = {
  display: 'block' as const,
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--t-text-muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  marginBottom: 4,
};

interface DirectiveEditorProps {
  title: string;
  scope: DirectiveScope;
  repoName: string;
  priority: number;
  content: string;
  repoNames: string[];
  saving: boolean;
  dirty: boolean;
  onTitleChange: (v: string) => void;
  onScopeChange: (scope: DirectiveScope, repoName: string) => void;
  onPriorityChange: (v: number) => void;
  onContentChange: (v: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

export const DirectiveEditor = forwardRef<HTMLDivElement, DirectiveEditorProps>(
  function DirectiveEditor(props, ref) {
    const {
      title, scope, repoName, priority, content,
      repoNames, saving, dirty,
      onTitleChange, onScopeChange, onPriorityChange, onContentChange,
      onSave, onDelete,
    } = props;

    const [confirmDelete, setConfirmDelete] = useState(false);

    const handleScopeSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      if (val === 'global') {
        onScopeChange('global', '');
      } else if (val === '__new_repo__') {
        onScopeChange('repo', '');
      } else {
        onScopeChange('repo', val);
      }
    }, [onScopeChange]);

    const handleDeleteConfirm = useCallback(() => {
      onDelete();
      setConfirmDelete(false);
    }, [onDelete]);

    const showRepoInput = scope === 'repo' && !repoNames.includes(repoName);

    return (
      <div
        ref={ref}
        style={{
          marginTop: 8,
          marginRight: 12,
          marginBottom: 16,
          marginLeft: 12,
          borderRadius: 14,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-bg-card)',
          overflow: 'hidden',
        }}
      >
        {/* Title */}
        <div style={{ paddingTop: 12, paddingRight: 14, paddingBottom: 0, paddingLeft: 14 }}>
          <label style={LABEL_STYLE}>Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
            style={INPUT_BASE}
          />
        </div>

        {/* Scope + Priority row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 12,
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 0,
            paddingLeft: 14,
          }}
        >
          <div style={{ flex: 1 }}>
            <label style={LABEL_STYLE}>Scope</label>
            <select
              value={scope === 'global' ? 'global' : repoName || '__new_repo__'}
              onChange={handleScopeSelect}
              onClick={(e) => e.stopPropagation()}
              onFocus={onInputFocus}
              onBlur={onInputBlur}
              style={{
                ...INPUT_BASE,
                appearance: 'none' as const,
                WebkitAppearance: 'none' as const,
                cursor: 'pointer',
              } as React.CSSProperties}
            >
              <option value="global">Global</option>
              {repoNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              <option value="__new_repo__">+ Custom repo...</option>
            </select>
          </div>

          {showRepoInput && (
            <div style={{ flex: 1 }}>
              <label style={LABEL_STYLE}>Repo name</label>
              <input
                type="text"
                value={repoName}
                placeholder="e.g. cortex-ide"
                onChange={(e) => onScopeChange('repo', e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={onInputFocus}
                onBlur={onInputBlur}
                style={INPUT_BASE}
              />
            </div>
          )}

          <div style={{ width: 72 }}>
            <label style={LABEL_STYLE}>Priority</label>
            <input
              type="number"
              min={0}
              max={100}
              value={priority}
              onChange={(e) => onPriorityChange(Number(e.target.value) || 0)}
              onClick={(e) => e.stopPropagation()}
              onFocus={onInputFocus}
              onBlur={onInputBlur}
              style={{ ...INPUT_BASE, paddingRight: 6, fontFamily: MONO_FONT }}
            />
          </div>
        </div>

        {/* Content textarea */}
        <div style={{ paddingTop: 10, paddingRight: 14, paddingBottom: 0, paddingLeft: 14 }}>
          <label style={LABEL_STYLE}>Content</label>
          <textarea
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Markdown directive body..."
            rows={8}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
            style={{
              ...INPUT_BASE,
              paddingTop: 8,
              paddingBottom: 8,
              fontSize: 12,
              fontFamily: MONO_FONT,
              lineHeight: '1.5',
              resize: 'vertical' as const,
            }}
          />
        </div>

        {/* Footer: token count + actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: 'var(--t-text-faint)',
              letterSpacing: '-0.01em',
            }}
          >
            Tokens: {tokenEstimate(content)}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Delete with inline confirm strip */}
            {confirmDelete ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--t-text-muted)', fontSize: 11, marginRight: 2 }}>
                  Confirm delete?
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDeleteConfirm(); }}
                  disabled={saving}
                  style={{
                    paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10,
                    borderRadius: 6,
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    background: 'rgba(239, 68, 68, 0.08)',
                    color: '#dc2626',
                    fontSize: 12, fontWeight: 500,
                    cursor: saving ? 'default' : 'pointer',
                    fontFamily: 'system-ui, sans-serif',
                    minHeight: 30,
                  }}
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  style={{
                    paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10,
                    borderRadius: 6,
                    border: '1px solid var(--t-input-border)',
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    fontSize: 12, fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: 'system-ui, sans-serif',
                    minHeight: 30,
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  paddingTop: 5, paddingRight: 10, paddingBottom: 5, paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid var(--t-input-border)',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 12, fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'system-ui, sans-serif',
                  minHeight: 30,
                }}
              >
                <TrashIcon size={13} color="var(--t-text-muted)" />
                Delete
              </button>
            )}

            {/* Save */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSave(); }}
              disabled={saving || !dirty}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                paddingTop: 5, paddingRight: 12, paddingBottom: 5, paddingLeft: 10,
                borderRadius: 8,
                border: dirty ? '1px solid var(--t-accent-border)' : '1px solid var(--t-input-border)',
                background: dirty ? 'var(--t-accent)' : 'transparent',
                color: dirty ? '#ffffff' : 'var(--t-text-faint)',
                fontSize: 12, fontWeight: 500,
                cursor: saving || !dirty ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
                fontFamily: 'system-ui, sans-serif',
                minHeight: 30,
                transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
              }}
            >
              <FloppyIcon size={13} color={dirty ? '#ffffff' : 'var(--t-text-faint)'} />
              Save
            </button>
          </div>
        </div>
      </div>
    );
  },
);
