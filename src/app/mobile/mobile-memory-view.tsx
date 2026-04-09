'use client';

/**
 * MobileMemoryView -- Cortex v2 directives management on mobile.
 *
 * Lists global + repo-scoped directives, lets the operator create, edit,
 * and delete them. The ledger is read-only here (the implicit memory layer
 * is populated by agent runs, not by hand).
 */

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Directive } from '@/lib/cortex/directives-types';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_TOUCH_TARGET,
  IconTrash,
  type MobilePalette,
  mobileFontFamily,
} from './mobile-approvals-shared';

interface MobileMemoryViewProps {
  palette: MobilePalette;
}

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export function MobileMemoryView({ palette }: MobileMemoryViewProps) {
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editPriority, setEditPriority] = useState(50);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/directives');
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json() as { directives?: Directive[] };
      setDirectives(data.directives ?? []);
      setError(null);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selectDirective = useCallback((d: Directive) => {
    if (dirty && selectedId && selectedId !== d.id) {
      const proceed = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes?')
        : true;
      if (!proceed) return;
    }
    setSelectedId(d.id);
    setEditTitle(d.title);
    setEditContent(d.content);
    setEditPriority(d.priority);
    setDirty(false);
  }, [dirty, selectedId]);

  const deselect = useCallback(() => {
    if (dirty) {
      const proceed = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes?')
        : true;
      if (!proceed) return;
    }
    setSelectedId(null);
    setDirty(false);
  }, [dirty]);

  const handleCreate = useCallback(async () => {
    try {
      setSaving(true);
      const res = await fetch('/api/directives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Untitled directive',
          scope: 'global',
          priority: 50,
          content: '',
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as { directive: Directive };
      setDirectives((prev) => [...prev, data.directive]);
      setSelectedId(data.directive.id);
      setEditTitle(data.directive.title);
      setEditContent(data.directive.content);
      setEditPriority(data.directive.priority);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    try {
      setSaving(true);
      const res = await fetch(`/api/directives/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          content: editContent,
          priority: editPriority,
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as { directive: Directive };
      setDirectives((prev) => prev.map((d) => d.id === data.directive.id ? data.directive : d));
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [selectedId, editTitle, editContent, editPriority]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    const proceed = typeof window !== 'undefined'
      ? window.confirm('Delete this directive?')
      : true;
    if (!proceed) return;
    try {
      setSaving(true);
      const res = await fetch(`/api/directives/${selectedId}`, { method: 'DELETE' });
      if (!res.ok) return;
      setDirectives((prev) => prev.filter((d) => d.id !== selectedId));
      setSelectedId(null);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [selectedId]);

  const canSave = dirty && !saving && editTitle.trim() !== '';

  const scrollAreaStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
  };

  const cardStyle = (active: boolean): CSSProperties => ({
    width: '100%',
    minHeight: MOBILE_TOUCH_TARGET,
    borderRadius: MOBILE_CARD_RADIUS,
    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
    background: active ? palette.accentSoft : palette.panelBackground,
    padding: '10px 12px',
    marginBottom: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    cursor: 'pointer',
    fontFamily: mobileFontFamily(),
    letterSpacing: MOBILE_BODY_TRACKING,
    textAlign: 'left',
  });

  const inputStyle: CSSProperties = {
    width: '100%',
    minHeight: MOBILE_TOUCH_TARGET,
    borderRadius: 10,
    border: `1px solid ${palette.cardBorder}`,
    background: palette.panelBackground,
    color: palette.rootText,
    padding: '10px 12px',
    fontSize: 14,
    fontFamily: mobileFontFamily(),
    letterSpacing: MOBILE_BODY_TRACKING,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: palette.subduedText,
    marginBottom: 6,
    display: 'block',
  };

  if (loading) {
    return (
      <div style={{ padding: 16, color: palette.subduedText, fontSize: 13 }}>
        Loading directives...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: palette.subduedText, fontSize: 13 }}>{error}</div>
    );
  }

  if (selectedId) {
    return (
      <div style={scrollAreaStyle}>
        <div style={{ padding: '4px 4px 16px' }}>
          <button
            type="button"
            onClick={deselect}
            style={{
              border: 'none',
              background: 'transparent',
              color: palette.accent,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              padding: '6px 4px',
              marginBottom: 12,
              fontFamily: mobileFontFamily(),
            }}
          >
            ‹ Back to list
          </button>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Title</label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => { setEditTitle(e.target.value); setDirty(true); }}
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Priority (1 = highest)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={editPriority}
              onChange={(e) => { setEditPriority(Number(e.target.value) || 0); setDirty(true); }}
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Content</label>
            <textarea
              value={editContent}
              onChange={(e) => { setEditContent(e.target.value); setDirty(true); }}
              rows={10}
              style={{
                ...inputStyle,
                fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                fontSize: 13,
                lineHeight: '1.5',
                resize: 'vertical',
              }}
            />
            <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 6, textAlign: 'right' }}>
              {tokenEstimate(editContent)} tokens
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              style={{
                minHeight: MOBILE_TOUCH_TARGET,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: MOBILE_CARD_RADIUS,
                border: `1px solid ${palette.dangerBorder}`,
                background: palette.dangerSoft,
                color: palette.danger,
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
                fontFamily: mobileFontFamily(),
              }}
            >
              <IconTrash fill={palette.danger} size={15} />
              Delete
            </button>

            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              style={{
                flex: 1,
                minHeight: MOBILE_TOUCH_TARGET,
                borderRadius: MOBILE_CARD_RADIUS,
                border: `1px solid ${canSave ? palette.accentBorder : palette.cardBorder}`,
                background: canSave ? palette.accent : palette.panelBackground,
                color: canSave ? '#ffffff' : palette.subduedText,
                fontSize: 14,
                fontWeight: 700,
                cursor: canSave ? 'pointer' : 'default',
                opacity: saving ? 0.6 : 1,
                fontFamily: mobileFontFamily(),
                letterSpacing: MOBILE_BODY_TRACKING,
              }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const globalDirectives = directives.filter((d) => d.scope === 'global').sort((a, b) => a.priority - b.priority);
  const repoMap = new Map<string, Directive[]>();
  for (const d of directives) {
    if (d.scope === 'repo' && d.repoName) {
      const list = repoMap.get(d.repoName) ?? [];
      list.push(d);
      repoMap.set(d.repoName, list);
    }
  }

  return (
    <div style={scrollAreaStyle}>
      <div style={{ padding: '4px 4px 16px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}>
          <div style={{ fontSize: 12, color: palette.subduedText }}>
            {directives.length} directive{directives.length === 1 ? '' : 's'}
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving}
            style={{
              minHeight: 36,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 10,
              border: `1px solid ${palette.accentBorder}`,
              background: palette.accentSoft,
              color: palette.accent,
              fontSize: 12,
              fontWeight: 700,
              cursor: saving ? 'default' : 'pointer',
              fontFamily: mobileFontFamily(),
            }}
          >
            + New
          </button>
        </div>

        {globalDirectives.length > 0 ? (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: palette.subduedText,
              marginBottom: 8,
              padding: '0 4px',
            }}>
              Global
            </div>
            {globalDirectives.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => selectDirective(d)}
                style={cardStyle(selectedId === d.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: palette.rootText,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {d.title}
                  </div>
                  <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 2 }}>
                    {tokenEstimate(d.content)} tokens
                  </div>
                </div>
                <div style={{
                  minWidth: 28,
                  height: 22,
                  borderRadius: 6,
                  background: palette.panelBackground,
                  border: `1px solid ${palette.cardBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  color: palette.subduedText,
                  flexShrink: 0,
                }}>
                  {d.priority}
                </div>
              </button>
            ))}
          </div>
        ) : null}

        {[...repoMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repoName, list]) => (
          <div key={repoName} style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: palette.subduedText,
              marginBottom: 8,
              padding: '0 4px',
            }}>
              {repoName}
            </div>
            {list.sort((a, b) => a.priority - b.priority).map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => selectDirective(d)}
                style={cardStyle(selectedId === d.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: palette.rootText,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {d.title}
                  </div>
                  <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 2 }}>
                    {tokenEstimate(d.content)} tokens
                  </div>
                </div>
                <div style={{
                  minWidth: 28,
                  height: 22,
                  borderRadius: 6,
                  background: palette.panelBackground,
                  border: `1px solid ${palette.cardBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  color: palette.subduedText,
                  flexShrink: 0,
                }}>
                  {d.priority}
                </div>
              </button>
            ))}
          </div>
        ))}

        {directives.length === 0 ? (
          <div style={{
            padding: 32,
            textAlign: 'center',
            color: palette.subduedText,
            fontSize: 13,
          }}>
            No directives yet. Tap + New to create one.
          </div>
        ) : null}
      </div>
    </div>
  );
}
