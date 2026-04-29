'use client';

/**
 * #773 — Editable packet spec.md (the "live spec").
 *
 * Renders inside the expanded packet card as an Issues-style row labelled
 * SPEC. Click to expand: shows the saved markdown body in a monospace
 * read pane with an EDIT button. Editing swaps to a textarea + Save / Cancel.
 *
 * The orchestrator re-reads the spec at dispatch time (see
 * `lib/orchestrator/packet-prompt.ts`) so a NEW launch picks up the latest
 * content. In-flight agents are not steered — that's the governance moat
 * vs. Augment Intent's auto-merge model.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Chevron,
  expandedSurfaceStyle,
  FONT_FAMILY,
  formatRelative,
  MONO_FAMILY,
  rowChromeStyle,
  rowLabelStyle,
  rowValueStyle,
} from '@/components/desktop/thoughts/recall-card/shared';

interface PacketSpecEditorProps {
  packetId: string;
}

interface SpecState {
  loading: boolean;
  content: string;
  updatedAt: string | null;
  error: string | null;
}

const PLACEHOLDER = `# Goal\n\nWhat are we trying to do?\n\n# Constraints\n\n- \n\n# Tasks\n\n- [ ] \n\n# Acceptance\n\n- [ ] \n`;

export function PacketSpecEditor({ packetId }: PacketSpecEditorProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<SpecState>({
    loading: true,
    content: '',
    updatedAt: null,
    error: null,
  });

  // Bump on save; the cheap re-fetch on the GET endpoint keeps us in sync
  // with any out-of-band writes (e.g. an agent-proposed update once that
  // surface lands).
  const [refreshTick, setRefreshTick] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Always keep the spec in sync. The first fetch fires on mount; subsequent
  // fetches fire when the operator clicks Save or when refreshTick bumps.
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetch(`/api/orchestrator/packet-spec?packetId=${encodeURIComponent(packetId)}`, {
      method: 'GET',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json() as { ok?: boolean; result?: { content?: string; updatedAt?: string | null } };
        if (!payload.ok || !payload.result) {
          throw new Error('Invalid response.');
        }
        setState({
          loading: false,
          content: typeof payload.result.content === 'string' ? payload.result.content : '',
          updatedAt: payload.result.updatedAt ?? null,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unable to load spec.';
        setState({ loading: false, content: '', updatedAt: null, error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [packetId, refreshTick]);

  const beginEdit = useCallback(() => {
    setDraft(state.content || PLACEHOLDER);
    setEditing(true);
    // Focus next tick so the textarea is mounted.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
      }
    });
  }, [state.content]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft('');
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch('/api/orchestrator/packet-spec', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId, content: draft }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json() as { ok?: boolean; result?: { updatedAt?: string }; error?: { message?: string } };
      if (!payload.ok) {
        throw new Error(payload.error?.message || 'Save failed.');
      }
      setEditing(false);
      setRefreshTick((tick) => tick + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.';
      setState((prev) => ({ ...prev, error: message }));
    } finally {
      setSaving(false);
    }
  }, [draft, packetId, saving]);

  const hasContent = state.content.trim().length > 0;
  const collapsedValue = state.loading
    ? 'Loading...'
    : hasContent
      ? firstNonEmptyLine(state.content)
      : 'No spec yet — click to add operator intent';

  return (
    <div
      data-packet-row
      style={{
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          ...rowChromeStyle,
          background: open ? 'var(--t-divider-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = 'var(--t-divider-subtle)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={rowLabelStyle}>spec</span>
        <span
          style={{
            ...rowValueStyle,
            color: hasContent ? 'var(--t-text)' : 'var(--t-text-muted)',
          }}
        >
          {collapsedValue}
        </span>
        {state.updatedAt ? (
          <span
            style={{
              fontSize: 9.5,
              color: 'var(--t-text-faint)',
              fontFamily: FONT_FAMILY,
              flexShrink: 0,
              letterSpacing: '-0.005em',
            }}
          >
            Updated {formatRelative(state.updatedAt)}
          </span>
        ) : null}
        <Chevron open={open} />
      </button>

      {open ? (
        <div
          style={{
            ...expandedSurfaceStyle,
            paddingLeft: 10,
            paddingRight: 10,
            paddingTop: 8,
            paddingBottom: 10,
            gap: 8,
          }}
        >
          {state.error ? (
            <div
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: 11,
                color: '#b91c1c',
              }}
            >
              {state.error}
            </div>
          ) : null}

          {editing ? (
            <>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void save();
                  }
                }}
                style={{
                  width: '100%',
                  minHeight: 200,
                  resize: 'vertical',
                  fontFamily: MONO_FAMILY,
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: 'var(--t-text)',
                  background: 'var(--t-input-bg, rgba(15, 23, 42, 0.04))',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-divider)',
                  borderRadius: 8,
                  paddingTop: 8,
                  paddingRight: 10,
                  paddingBottom: 8,
                  paddingLeft: 10,
                  outline: 'none',
                  letterSpacing: '-0.005em',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  style={{
                    borderWidth: 0,
                    background: '#2563eb',
                    color: '#fff',
                    paddingTop: 4,
                    paddingRight: 10,
                    paddingBottom: 4,
                    paddingLeft: 10,
                    borderRadius: 6,
                    fontSize: 10.5,
                    fontWeight: 700,
                    cursor: saving ? 'wait' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                    fontFamily: FONT_FAMILY,
                    letterSpacing: '-0.01em',
                  }}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  style={{
                    borderWidth: 0,
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    paddingTop: 4,
                    paddingRight: 8,
                    paddingBottom: 4,
                    paddingLeft: 8,
                    borderRadius: 6,
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: saving ? 'wait' : 'pointer',
                    fontFamily: FONT_FAMILY,
                  }}
                >
                  Cancel
                </button>
                <span
                  style={{
                    fontFamily: FONT_FAMILY,
                    fontSize: 9.5,
                    color: 'var(--t-text-faint)',
                    marginLeft: 'auto',
                    letterSpacing: '-0.005em',
                  }}
                >
                  Cmd/Ctrl + Enter to save · Esc to cancel
                </span>
              </div>
            </>
          ) : (
            <>
              {hasContent ? (
                <pre
                  style={{
                    margin: 0,
                    fontFamily: MONO_FAMILY,
                    fontSize: 11.5,
                    lineHeight: 1.55,
                    color: 'var(--t-text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    letterSpacing: '-0.005em',
                  }}
                >
                  {state.content}
                </pre>
              ) : (
                <div
                  style={{
                    fontFamily: FONT_FAMILY,
                    fontSize: 11,
                    color: 'var(--t-text-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  Add an editable spec for this packet — the orchestrator re-reads it on every dispatch so the agent always sees your current intent. In-flight agents keep their original prompt; only the next launch picks up edits.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  onClick={beginEdit}
                  style={{
                    borderWidth: 0,
                    background: hasContent ? 'transparent' : '#2563eb',
                    color: hasContent ? '#2563eb' : '#fff',
                    paddingTop: 4,
                    paddingRight: 10,
                    paddingBottom: 4,
                    paddingLeft: 10,
                    borderRadius: 6,
                    fontSize: 10.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: FONT_FAMILY,
                    letterSpacing: '-0.01em',
                  }}
                  onMouseEnter={(e) => {
                    if (hasContent) e.currentTarget.style.background = 'rgba(37, 99, 235, 0.08)';
                  }}
                  onMouseLeave={(e) => {
                    if (hasContent) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {hasContent ? 'Edit' : 'Add spec'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function firstNonEmptyLine(content: string): string {
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim().replace(/^#+\s*/, '');
    if (trimmed) {
      return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
    }
  }
  return 'Empty spec';
}
