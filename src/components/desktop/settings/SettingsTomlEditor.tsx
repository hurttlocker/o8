'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { tags } from '@lezer/highlight';

import type { OperatorDefaultsResponse } from './dispatch-shared';
import { fetchOperatorDefaults } from './operator-defaults-client';
import { APP_FONT_STACK, MONO_FONT_STACK, SETTINGS_CONTENT_MAX_WIDTH } from './shared';

const tomlHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--t-text-faint)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--t-success)' },
  { tag: [tags.number, tags.bool], color: 'var(--t-settings-accent-strong)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--t-text)' },
  { tag: tags.punctuation, color: 'var(--t-text-muted)' },
]);

const editorTheme = EditorView.theme({
  '&': {
    height: 'min(620px, calc(100vh - 260px))',
    minHeight: '360px',
    backgroundColor: 'var(--t-input-bg)',
    color: 'var(--t-text)',
    fontFamily: MONO_FONT_STACK,
    fontSize: '12px',
    fontWeight: '300',
  },
  '.cm-scroller': {
    overflow: 'auto',
    lineHeight: '1.55',
  },
  '.cm-content': {
    paddingTop: '14px',
    paddingBottom: '14px',
    caretColor: 'var(--t-settings-accent-strong)',
  },
  '.cm-line': {
    paddingLeft: '16px',
    paddingRight: '16px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--t-panel)',
    color: 'var(--t-text-faint)',
    borderRight: '1px solid var(--t-divider-subtle)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--t-hover)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--t-hover)',
    color: 'var(--t-text-muted)',
  },
  '&.cm-focused': {
    outline: '1px solid var(--t-settings-accent-border)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--t-settings-accent-soft-strong)',
  },
});

const buttonBase = {
  height: 30,
  paddingLeft: 13,
  paddingRight: 13,
  borderRadius: 7,
  fontFamily: APP_FONT_STACK,
  fontSize: 11,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  cursor: 'pointer',
} as const;

export function SettingsTomlEditor({
  initialText,
  filePath,
  initialError,
  onCancel,
  onSaved,
}: {
  initialText: string;
  filePath: string;
  initialError: string | null;
  onCancel: () => void;
  onSaved: (payload: OperatorDefaultsResponse) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(initialText);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          StreamLanguage.define(toml),
          syntaxHighlighting(tomlHighlight),
          editorTheme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            valueRef.current = update.state.doc.toString();
            setDirty(true);
            setError(null);
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [initialText]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetchOperatorDefaults({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsToml: valueRef.current }),
      });
      const payload = await response.json().catch(() => ({})) as OperatorDefaultsResponse & { error?: string };
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to save settings.toml.');
      }
      setDirty(false);
      onSaved(payload);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save settings.toml.');
    } finally {
      setSaving(false);
    }
  }, [onSaved]);

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        marginBottom: 18,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: 'var(--t-text)',
            fontSize: 18,
            fontWeight: 400,
            letterSpacing: '-0.2px',
            lineHeight: 1.25,
          }}>
            settings.toml
          </div>
          <div style={{
            marginTop: 6,
            color: 'var(--t-text-muted)',
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }} title={filePath}>
            {filePath}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={{
              ...buttonBase,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text-muted)',
              opacity: saving ? 0.55 : 1,
            }}
          >
            Back to form
          </button>
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={saving || (!dirty && !initialError)}
            style={{
              ...buttonBase,
              border: '1px solid var(--t-settings-accent-border)',
              background: 'var(--t-settings-accent-soft)',
              color: 'var(--t-settings-accent-strong)',
              opacity: saving || (!dirty && !initialError) ? 0.55 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save settings.toml'}
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" style={{
          marginBottom: 12,
          paddingTop: 9,
          paddingRight: 12,
          paddingBottom: 9,
          paddingLeft: 12,
          border: '1px solid var(--t-danger-border)',
          borderRadius: 7,
          background: 'var(--t-danger-soft)',
          color: 'var(--t-danger)',
          fontSize: 12,
          fontWeight: 300,
          lineHeight: 1.45,
        }}>
          {error}
        </div>
      ) : null}

      <div style={{
        overflow: 'hidden',
        border: '1px solid var(--t-panel-border)',
        borderRadius: 9,
        background: 'var(--t-input-bg)',
      }} ref={hostRef} />
      <div style={{
        marginTop: 10,
        color: 'var(--t-text-faint)',
        fontSize: 10,
        fontWeight: 300,
        lineHeight: 1.45,
      }}>
        Values are parsed and validated before they apply. If this file is corrupt, o8 keeps running on the last-good defaults and leaves the file untouched.
      </div>
    </div>
  );
}
