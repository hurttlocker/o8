'use client';

/**
 * DirectivesView -- Operator-authored directives management surface.
 *
 * Replaces the lava lamp / 3D graph in the Memory nav section.
 * Self-contained: fetches from /api/directives, grouped by scope,
 * inline editor with CRUD.
 *
 * Icons: directives-icons.tsx
 * Editor pane: DirectiveEditor.tsx
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Directive, DirectiveScope } from '@/lib/cortex/directives-types';
import {
  PlusIcon,
  FileTextIcon,
  GlobeIcon,
  FolderIcon,
  ListIcon,
  EyeIcon,
} from '@/components/desktop/directives-icons';
import { DirectiveEditor } from '@/components/desktop/DirectiveEditor';
import { LedgerView } from '@/components/desktop/LedgerView';
import { PreviewView } from '@/components/desktop/PreviewView';

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

type ActiveTab = 'directives' | 'ledger' | 'preview';

// ── Helpers ──

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function groupDirectives(directives: Directive[]): Map<string, Directive[]> {
  const groups = new Map<string, Directive[]>();

  const global = directives.filter((d) => d.scope === 'global');
  if (global.length > 0) groups.set('Global', global);

  const repos = new Map<string, Directive[]>();
  for (const d of directives) {
    if (d.scope === 'repo' && d.repoName) {
      const list = repos.get(d.repoName) || [];
      list.push(d);
      repos.set(d.repoName, list);
    }
  }
  for (const [name, list] of [...repos.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.set(name, list);
  }

  return groups;
}

// ── Main Component ──

export function DirectivesView(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ActiveTab>('directives');
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editor state
  const [editTitle, setEditTitle] = useState('');
  const [editScope, setEditScope] = useState<DirectiveScope>('global');
  const [editRepoName, setEditRepoName] = useState('');
  const [editPriority, setEditPriority] = useState(50);
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);

  // ── Fetch ──

  const fetchDirectives = useCallback(async () => {
    try {
      const res = await fetch('/api/directives');
      if (!res.ok) { setError('Failed to load directives'); return; }
      const data = await res.json();
      setDirectives(data.directives || []);
      setError(null);
    } catch (e) {
      console.error('[directives] fetch error:', e);
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDirectives(); }, [fetchDirectives]);

  // ── Select / deselect ──

  const selectDirective = useCallback((d: Directive) => {
    setSelectedId(d.id);
    setEditTitle(d.title);
    setEditScope(d.scope);
    setEditRepoName(d.repoName || '');
    setEditPriority(d.priority);
    setEditContent(d.content);
    setDirty(false);
    requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, []);

  const deselectDirective = useCallback(() => {
    setSelectedId(null);
    setDirty(false);
  }, []);

  // ── Create ──

  const handleCreate = useCallback(async () => {
    try {
      setSaving(true);
      const res = await fetch('/api/directives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Untitled directive',
          scope: 'global',
          repoName: null,
          priority: 50,
          content: '',
        }),
      });
      if (!res.ok) { console.error('[directives] create failed'); return; }
      const data = await res.json();
      const created = data.directive as Directive;
      setDirectives((prev) => [...prev, created]);
      selectDirective(created);
    } catch (e) {
      console.error('[directives] create error:', e);
    } finally {
      setSaving(false);
    }
  }, [selectDirective]);

  // ── Save ──

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    try {
      setSaving(true);
      const res = await fetch(`/api/directives/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          scope: editScope,
          repoName: editScope === 'repo' ? editRepoName || null : null,
          priority: editPriority,
          content: editContent,
        }),
      });
      if (!res.ok) { console.error('[directives] save failed'); return; }
      const data = await res.json();
      const updated = data.directive as Directive;
      setDirectives((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      setDirty(false);
    } catch (e) {
      console.error('[directives] save error:', e);
    } finally {
      setSaving(false);
    }
  }, [selectedId, editTitle, editScope, editRepoName, editPriority, editContent]);

  // ── Delete ──

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    try {
      setSaving(true);
      const res = await fetch(`/api/directives/${selectedId}`, { method: 'DELETE' });
      if (!res.ok) { console.error('[directives] delete failed'); return; }
      setDirectives((prev) => prev.filter((d) => d.id !== selectedId));
      deselectDirective();
    } catch (e) {
      console.error('[directives] delete error:', e);
    } finally {
      setSaving(false);
    }
  }, [selectedId, deselectDirective]);

  // ── Editor field change handlers ──

  const handleTitleChange = useCallback((v: string) => { setEditTitle(v); setDirty(true); }, []);
  const handleScopeChange = useCallback((scope: DirectiveScope, repo: string) => {
    setEditScope(scope);
    setEditRepoName(repo);
    setDirty(true);
  }, []);
  const handlePriorityChange = useCallback((v: number) => { setEditPriority(v); setDirty(true); }, []);
  const handleContentChange = useCallback((v: string) => { setEditContent(v); setDirty(true); }, []);

  // ── Derived ──

  const grouped = useMemo(() => groupDirectives(directives), [directives]);
  const totalTokens = useMemo(
    () => directives.reduce((sum, d) => sum + tokenEstimate(d.content), 0),
    [directives],
  );
  const repoNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of directives) { if (d.repoName) names.add(d.repoName); }
    return [...names].sort();
  }, [directives]);

  // ── Loading / Error states ──

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'var(--t-text-muted)', fontSize: 13,
        fontFamily: 'system-ui, sans-serif',
      }}>
        Loading directives...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'var(--t-text-muted)', fontSize: 13,
        fontFamily: 'system-ui, sans-serif',
      }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      fontFamily: 'system-ui, sans-serif',
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 16, paddingRight: 16, paddingBottom: 12, paddingLeft: 16,
        borderBottom: '1px solid var(--t-divider)', flexShrink: 0,
      }}>
        <span style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--t-text)', letterSpacing: '-0.02em',
        }}>
          Memory
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 11, fontFamily: MONO_FONT,
            color: 'var(--t-text-muted)', letterSpacing: '-0.01em',
          }}>
            {totalTokens}t
          </span>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving || activeTab !== 'directives'}
            style={{
              display: activeTab === 'directives' ? 'flex' : 'none',
              alignItems: 'center', gap: 4,
              paddingTop: 5, paddingRight: 10, paddingBottom: 5, paddingLeft: 8,
              borderRadius: 8,
              border: '1px solid var(--t-accent-border)',
              background: 'var(--t-accent-soft)',
              color: 'var(--t-accent)',
              fontSize: 12, fontWeight: 500,
              cursor: saving ? 'default' : 'pointer',
              opacity: saving ? 0.6 : 1,
              fontFamily: 'system-ui, sans-serif',
              letterSpacing: '-0.01em',
              minHeight: 30,
            }}
          >
            <PlusIcon size={13} color="var(--t-accent)" />
            New
          </button>
        </div>
      </div>

      {/* ── Tab Bar ── */}
      <TabBar activeTab={activeTab} onChange={setActiveTab} />

      {/* ── Scrollable content (tab-switched) ── */}
      {activeTab === 'directives' && (
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {directives.length === 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              paddingTop: 48, paddingBottom: 48,
              color: 'var(--t-text-muted)', fontSize: 13, gap: 8,
            }}>
              <FileTextIcon size={24} color="var(--t-text-faint)" />
              <span>No directives yet</span>
              <span style={{ fontSize: 12, color: 'var(--t-text-faint)' }}>
                Create one to inject rules into agent sessions
              </span>
            </div>
          )}

          {[...grouped.entries()].map(([groupName, items]) => (
            <div key={groupName}>
              {/* Group header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                paddingTop: 12, paddingRight: 16, paddingBottom: 6, paddingLeft: 16,
              }}>
                {groupName === 'Global'
                  ? <GlobeIcon size={11} color="var(--t-text-faint)" />
                  : <FolderIcon size={11} color="var(--t-text-faint)" />}
                <span style={{
                  fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  {groupName}
                </span>
              </div>

              {/* Directive cards */}
              <div style={{ paddingRight: 12, paddingLeft: 12 }}>
                {items.sort((a, b) => a.priority - b.priority).map((d) => {
                  const isSelected = selectedId === d.id;
                  return (
                    <DirectiveCard
                      key={d.id}
                      directive={d}
                      isSelected={isSelected}
                      onSelect={() => isSelected ? deselectDirective() : selectDirective(d)}
                    />
                  );
                })}
              </div>
            </div>
          ))}

          {/* ── Inline Editor ── */}
          {selectedId && (
            <DirectiveEditor
              ref={editorRef}
              title={editTitle}
              scope={editScope}
              repoName={editRepoName}
              priority={editPriority}
              content={editContent}
              repoNames={repoNames}
              saving={saving}
              dirty={dirty}
              onTitleChange={handleTitleChange}
              onScopeChange={handleScopeChange}
              onPriorityChange={handlePriorityChange}
              onContentChange={handleContentChange}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          )}
        </div>
      )}

      {activeTab === 'ledger' && <LedgerView active={activeTab === 'ledger'} />}
      {activeTab === 'preview' && <PreviewView active={activeTab === 'preview'} />}
    </div>
  );
}

// ── Directive Card (extracted to reduce main render body) ──

function DirectiveCard({
  directive: d,
  isSelected,
  onSelect,
}: {
  directive: Directive;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const lines = lineCount(d.content);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12,
        marginBottom: 2, borderRadius: 14,
        border: isSelected ? '1px solid var(--t-accent-border)' : '1px solid transparent',
        background: isSelected ? 'var(--t-accent-soft)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
        minHeight: 44,
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 2,
        minWidth: 0, flex: 1,
      }}>
        <span style={{
          fontSize: 13, fontWeight: 500, color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {d.title || 'Untitled'}
        </span>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, color: 'var(--t-text-faint)', letterSpacing: '-0.01em',
        }}>
          <span>{lines} line{lines !== 1 ? 's' : ''}</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>{d.scope === 'global' ? 'Global' : d.repoName || 'Repo'}</span>
        </div>
      </div>

      {/* Priority badge */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 28, height: 22, borderRadius: 6,
        background: 'var(--t-bg-card)',
        fontSize: 11, fontWeight: 600, fontFamily: MONO_FONT,
        color: 'var(--t-text-muted)', letterSpacing: '-0.01em',
        flexShrink: 0, marginLeft: 8,
      }}>
        {d.priority}
      </div>
    </div>
  );
}

// ── Tab Bar ──

function TabBar({
  activeTab,
  onChange,
}: {
  activeTab: ActiveTab;
  onChange: (tab: ActiveTab) => void;
}) {
  const tabs: Array<{ id: ActiveTab; label: string; icon: React.ReactElement }> = [
    { id: 'directives', label: 'Directives', icon: <FileTextIcon size={12} color="currentColor" /> },
    { id: 'ledger', label: 'Ledger', icon: <ListIcon size={12} color="currentColor" /> },
    { id: 'preview', label: 'Preview', icon: <EyeIcon size={12} color="currentColor" /> },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      paddingLeft: 12, paddingRight: 12,
      borderBottom: '1px solid var(--t-divider)',
      flexShrink: 0,
      gap: 2,
    }}>
      {tabs.map((t) => {
        const isActive = activeTab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
              background: 'transparent',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--t-accent)' : '2px solid transparent',
              color: isActive ? 'var(--t-accent)' : 'var(--t-text-muted)',
              fontSize: 12, fontWeight: 500,
              fontFamily: 'system-ui, sans-serif',
              letterSpacing: '-0.01em',
              cursor: 'pointer',
              minHeight: 36,
              marginBottom: -1,
            }}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

