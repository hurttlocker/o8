'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  copyPromptText,
  createSavedPrompt,
  deleteSavedPrompt,
  importSavedPromptSources,
  listSavedPrompts,
  listPromptImportSources,
  recordSavedPromptUse,
  updateSavedPrompt,
  type PromptLibraryEntry,
  type PromptLibraryImportSource,
  type PromptLibraryScope,
} from '@/lib/prompt-library/client';
import { EmptyState, Row, SectionHeader, TruncatedRows } from './shared';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

interface PromptEditorState {
  id: string | null;
  title: string;
  body: string;
  tags: string;
  scope: PromptLibraryScope;
}

export function PromptLibraryTab({ query, repoPath, repoName, onInsert, onCountDelta }: {
  query: string;
  repoPath: string | null;
  repoName: string;
  onInsert: (prompt: PromptLibraryEntry) => void;
  onCountDelta: (delta: number) => void;
}) {
  const [prompts, setPrompts] = useState<PromptLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const [importSources, setImportSources] = useState<PromptLibraryImportSource[]>([]);
  const [importConfirm, setImportConfirm] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = await listSavedPrompts({ query, repoPath, signal });
      setPrompts(next);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Saved prompts could not be loaded.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query, repoPath]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, query ? 120 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, refresh]);

  const refreshImportSources = useCallback(async (signal?: AbortSignal) => {
    try {
      setImportSources(await listPromptImportSources(repoPath, signal));
    } catch (cause) {
      if (!signal?.aborted) {
        setError(cause instanceof Error ? cause.message : 'Existing prompts could not be inspected.');
      }
    }
  }, [repoPath]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshImportSources(controller.signal);
    return () => controller.abort();
  }, [refreshImportSources]);

  const grouped = useMemo(() => ({
    global: prompts.filter((prompt) => prompt.scope === 'global'),
    repo: prompts.filter((prompt) => prompt.scope === 'repo'),
  }), [prompts]);

  const openCreate = () => {
    setEditor({ id: null, title: '', body: '', tags: '', scope: repoPath ? 'repo' : 'global' });
    setNotice(null);
  };

  const openEdit = (prompt: PromptLibraryEntry) => {
    setEditor({
      id: prompt.id,
      title: prompt.title,
      body: prompt.body,
      tags: prompt.tags.join(', '),
      scope: prompt.scope,
    });
    setExpandedId(prompt.id);
    setDeleteId(null);
    setNotice(null);
  };

  const save = async (draft: PromptEditorState) => {
    const input = {
      title: draft.title,
      body: draft.body,
      tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      scope: draft.scope,
      repoPath: draft.scope === 'repo' ? repoPath : null,
    };
    try {
      if (draft.id) {
        await updateSavedPrompt(draft.id, input);
        setNotice('Prompt updated.');
      } else {
        const result = await createSavedPrompt(input);
        if (result.created) onCountDelta(1);
        setNotice(result.created ? 'Prompt saved.' : 'That prompt was already saved in this scope.');
      }
      setEditor(null);
      await refresh();
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('The prompt could not be saved.');
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteSavedPrompt(id);
      onCountDelta(-1);
      setDeleteId(null);
      setExpandedId(null);
      setNotice('Prompt deleted.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The prompt could not be deleted.');
    }
  };

  const copy = async (prompt: PromptLibraryEntry) => {
    try {
      await copyPromptText(prompt.body);
      setCopiedId(prompt.id);
      window.setTimeout(() => setCopiedId((current) => current === prompt.id ? null : current), 1400);
      void recordSavedPromptUse(prompt.id).catch(() => {});
    } catch {
      setError('The prompt could not be copied.');
    }
  };

  const insert = (prompt: PromptLibraryEntry) => {
    void recordSavedPromptUse(prompt.id).catch(() => {});
    onInsert(prompt);
  };

  const importExisting = async () => {
    if (importBusy || importSources.length === 0) return;
    setImportBusy(true);
    setError(null);
    try {
      const result = await importSavedPromptSources(importSources, repoPath);
      if (result.created > 0) onCountDelta(result.created);
      const skipped = result.skipped > 0 ? ` ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped.` : '';
      setNotice(`Imported ${result.created} prompt${result.created === 1 ? '' : 's'}.${skipped}`);
      setImportConfirm(false);
      await Promise.all([refresh(), refreshImportSources()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Existing prompts could not be imported.');
    } finally {
      setImportBusy(false);
    }
  };

  const createButton = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {importSources.length > 0 ? (
        <QuietButton label="Import existing" onClick={() => setImportConfirm(true)} />
      ) : null}
      <QuietButton label="New prompt" onClick={openCreate} />
    </div>
  );

  if (loading && prompts.length === 0 && !editor) {
    return <div style={{ paddingTop: 32, fontSize: 11, fontWeight: 300, color: 'var(--t-text-faint)' }}>Loading saved prompts…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionHeader label="Saved prompts" count={prompts.length} action={createButton} />
      {notice ? <StatusLine text={notice} /> : null}
      {error ? <StatusLine text={error} error /> : null}
      {importConfirm ? (
        <ImportConfirmStrip
          sources={importSources}
          busy={importBusy}
          onCancel={() => setImportConfirm(false)}
          onImport={() => void importExisting()}
        />
      ) : null}
      {editor && editor.id === null ? (
        <PromptEditor
          value={editor}
          repoName={repoName}
          repoAvailable={Boolean(repoPath)}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSave={save}
        />
      ) : null}

      {!editor && prompts.length === 0 ? (
        <EmptyState
          title={query ? 'No matching prompts' : 'No saved prompts yet'}
          body={query
            ? 'Search checks prompt titles, text, and tags.'
            : 'Save the briefs worth repeating. Only prompts you choose are added to this library.'}
          actionLabel={query ? undefined : 'Create prompt'}
          onAction={query ? undefined : openCreate}
        />
      ) : null}

      {grouped.global.length > 0 ? (
        <PromptSection
          label="Global"
          prompts={grouped.global}
          expandedId={expandedId}
          deleteId={deleteId}
          copiedId={copiedId}
          onExpand={setExpandedId}
          onDeleteRequest={setDeleteId}
          onDelete={remove}
          onEdit={openEdit}
          onCopy={copy}
          onInsert={insert}
          editor={editor}
          repoName={repoName}
          repoAvailable={Boolean(repoPath)}
          onEditorChange={setEditor}
          onEditorCancel={() => setEditor(null)}
          onEditorSave={save}
        />
      ) : null}
      {grouped.repo.length > 0 ? (
        <PromptSection
          label={repoName}
          prompts={grouped.repo}
          expandedId={expandedId}
          deleteId={deleteId}
          copiedId={copiedId}
          onExpand={setExpandedId}
          onDeleteRequest={setDeleteId}
          onDelete={remove}
          onEdit={openEdit}
          onCopy={copy}
          onInsert={insert}
          editor={editor}
          repoName={repoName}
          repoAvailable={Boolean(repoPath)}
          onEditorChange={setEditor}
          onEditorCancel={() => setEditor(null)}
          onEditorSave={save}
        />
      ) : null}
    </div>
  );
}

function PromptSection({ label, prompts, expandedId, deleteId, copiedId, onExpand, onDeleteRequest, onDelete, onEdit, onCopy, onInsert, editor, repoName, repoAvailable, onEditorChange, onEditorCancel, onEditorSave }: {
  label: string;
  prompts: PromptLibraryEntry[];
  expandedId: string | null;
  deleteId: string | null;
  copiedId: string | null;
  onExpand: (id: string | null) => void;
  onDeleteRequest: (id: string | null) => void;
  onDelete: (id: string) => void;
  onEdit: (prompt: PromptLibraryEntry) => void;
  onCopy: (prompt: PromptLibraryEntry) => void;
  onInsert: (prompt: PromptLibraryEntry) => void;
  editor: PromptEditorState | null;
  repoName: string;
  repoAvailable: boolean;
  onEditorChange: (next: PromptEditorState) => void;
  onEditorCancel: () => void;
  onEditorSave: (next: PromptEditorState) => Promise<void>;
}) {
  return (
    <>
      <SectionHeader label={label} count={prompts.length} />
      <TruncatedRows rows={prompts.map((prompt) => {
        const editing = editor?.id === prompt.id;
        return (
        <Row
          key={prompt.id}
          title={prompt.title}
          subtitle={prompt.body.replace(/\s+/g, ' ').slice(0, 150)}
          pill={prompt.tags[0] ?? (prompt.useCount > 0 ? `${prompt.useCount} uses` : null)}
          expanded={expandedId === prompt.id || editing}
          onClick={() => onExpand(expandedId === prompt.id ? null : prompt.id)}
        >
          {editing ? (
            <PromptEditor
              value={editor}
              repoName={repoName}
              repoAvailable={repoAvailable}
              onChange={onEditorChange}
              onCancel={onEditorCancel}
              onSave={onEditorSave}
              inline
            />
          ) : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--t-text-secondary)', maxHeight: 240, overflowY: 'auto' }}>
              {prompt.body}
            </div>
            {prompt.tags.length > 0 ? (
              <div style={{ fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 300, color: 'var(--t-text-faint)' }}>
                {prompt.tags.join('  ·  ')}
              </div>
            ) : null}
            {deleteId === prompt.id ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
                <span style={{ flex: 1, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}>Delete this saved prompt?</span>
                <QuietButton label="Cancel" onClick={() => onDeleteRequest(null)} />
                <QuietButton label="Delete" onClick={() => void onDelete(prompt.id)} danger />
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <QuietButton label="Insert" onClick={() => onInsert(prompt)} primary />
                <QuietButton label={copiedId === prompt.id ? 'Copied' : 'Copy'} onClick={() => void onCopy(prompt)} />
                <QuietButton label="Edit" onClick={() => onEdit(prompt)} />
                <QuietButton label="Delete" onClick={() => onDeleteRequest(prompt.id)} danger />
              </div>
            )}
          </div>}
        </Row>
        );
      })} />
    </>
  );
}

function PromptEditor({ value, repoName, repoAvailable, onChange, onCancel, onSave, inline = false }: {
  value: PromptEditorState;
  repoName: string;
  repoAvailable: boolean;
  onChange: (next: PromptEditorState) => void;
  onCancel: () => void;
  onSave: (next: PromptEditorState) => Promise<void>;
  inline?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = Boolean(value.title.trim() && value.body.trim() && (value.scope !== 'repo' || repoAvailable));
  const set = (patch: Partial<PromptEditorState>) => onChange({ ...value, ...patch });
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 14,
      paddingBottom: 14,
      paddingLeft: 14,
      paddingRight: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-divider-subtle)',
      background: inline ? 'transparent' : 'var(--t-bg-card)',
      ...(inline ? {
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
        borderWidth: 0,
      } : {}),
    }}>
      <FieldLabel text="Title" />
      <input value={value.title} onChange={(event) => set({ title: event.currentTarget.value })} autoFocus style={fieldStyle} />
      <FieldLabel text="Prompt" />
      <textarea value={value.body} onChange={(event) => set({ body: event.currentTarget.value })} rows={9} style={{ ...fieldStyle, minHeight: 180, resize: 'vertical', lineHeight: 1.5 }} />
      <FieldLabel text="Tags" hint="comma separated" />
      <input value={value.tags} onChange={(event) => set({ tags: event.currentTarget.value })} placeholder="security, review, release" style={fieldStyle} />
      <FieldLabel text="Scope" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <ScopeButton active={value.scope === 'global'} label="Global" onClick={() => set({ scope: 'global' })} />
        <ScopeButton active={value.scope === 'repo'} label={repoAvailable ? repoName : 'Repo unavailable'} disabled={!repoAvailable} onClick={() => set({ scope: 'repo' })} />
      </div>
      {error ? <StatusLine text={error} error /> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
        <QuietButton label="Cancel" onClick={onCancel} disabled={busy} />
        <QuietButton
          label={busy ? 'Saving…' : value.id ? 'Save changes' : 'Save prompt'}
          onClick={() => {
            if (!canSave || busy) return;
            setBusy(true);
            setError(null);
            void onSave(value).catch((cause) => {
              setError(cause instanceof Error ? cause.message : 'The prompt could not be saved.');
              setBusy(false);
            });
          }}
          disabled={!canSave || busy}
          primary
        />
      </div>
    </div>
  );
}

function ImportConfirmStrip({ sources, busy, onCancel, onImport }: {
  sources: PromptLibraryImportSource[];
  busy: boolean;
  onCancel: () => void;
  onImport: () => void;
}) {
  const automations = sources.filter((source) => source.sourceKind === 'automation').length;
  const watched = sources.length - automations;
  const summary = [
    automations > 0 ? `${automations} automation${automations === 1 ? '' : 's'}` : '',
    watched > 0 ? `${watched} watched agent${watched === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, paddingTop: 4, paddingBottom: 4, paddingLeft: 10, paddingRight: 4, borderRadius: 9, background: 'var(--t-bg-card)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--t-text)' }}>Import {sources.length} existing prompt{sources.length === 1 ? '' : 's'}?</span>
        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{summary} · original repo scope preserved</span>
      </div>
      <QuietButton label="Cancel" onClick={onCancel} disabled={busy} />
      <QuietButton label={busy ? 'Importing…' : 'Import'} onClick={onImport} disabled={busy} primary />
    </div>
  );
}

function ScopeButton({ active, label, onClick, disabled = false }: { active: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{
      minHeight: 44,
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: 12,
      paddingRight: 12,
      border: 'none',
      borderRadius: 7,
      background: active ? 'var(--t-input-bg)' : 'transparent',
      color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
      fontSize: 12,
      fontWeight: 300,
      fontFamily: UI_FONT,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    }}>{label}</button>
  );
}

function QuietButton({ label, onClick, primary = false, danger = false, disabled = false }: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{
      minHeight: 44,
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: 11,
      paddingRight: 11,
      border: 'none',
      borderRadius: 7,
      background: primary ? 'var(--t-accent)' : 'transparent',
      color: primary ? 'var(--t-accent-contrast, #fff)' : danger ? 'var(--t-danger, #ef4444)' : 'var(--t-text-muted)',
      fontSize: 12,
      fontWeight: 300,
      fontFamily: UI_FONT,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    }}>{label}</button>
  );
}

function FieldLabel({ text, hint }: { text: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)' }}>{text}</span>
      {hint ? <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{hint}</span> : null}
    </div>
  );
}

function StatusLine({ text, error = false }: { text: string; error?: boolean }) {
  return <div role={error ? 'alert' : 'status'} style={{ minHeight: 28, paddingTop: 6, fontSize: 11, fontWeight: 300, color: error ? 'var(--t-danger, #ef4444)' : 'var(--t-text-muted)' }}>{text}</div>;
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 44,
  paddingTop: 9,
  paddingBottom: 9,
  paddingLeft: 10,
  paddingRight: 10,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-subtle)',
  borderRadius: 8,
  outline: 'none',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 12.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: UI_FONT,
  boxSizing: 'border-box',
};
