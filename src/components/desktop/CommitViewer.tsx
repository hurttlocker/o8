'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- extracted from Canvas.tsx */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  FileText,
  Send,
  X,
} from './lucide-shims';
import dynamic from 'next/dynamic';
import { useTheme } from '@/lib/theme/context';
import { formatAge } from './canvas-utils';
import { getMonacoLanguage, defineCortexMonacoThemes } from './FileViewer';
import { DiffStatusIcon, renderDiffLines } from './diff-utils';

const MonacoEditor = dynamic(() => import('@/lib/monaco-polyfills').then(() =>
  import('@monaco-editor/react').then((mod) => mod.default)
), {
  ssr: false,
  loading: () => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading editor…</div>,
});
const MonacoDiffEditor = dynamic(() => import('@/lib/monaco-polyfills').then(() =>
  import('@monaco-editor/react').then((mod) => mod.DiffEditor)
), {
  ssr: false,
  loading: () => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading diff…</div>,
});

// ── Commit Viewer ──

interface CommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  files: { path: string; additions: number | null; deletions: number | null; status?: string }[];
  totalAdditions: number;
  totalDeletions: number;
  diff: string;
}

interface CommitFileCompare {
  path: string;
  status: string;
  commitContent: string | null;
  commitSource: 'commit' | 'parent' | null;
  workspaceContent: string | null;
  workspaceExists: boolean;
  note?: string;
}

export function CommitViewer({ commitHash, workspace }: { commitHash: string; workspace?: string }) {
  const { themeId } = useTheme();
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [compareData, setCompareData] = useState<CommitFileCompare | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [commitComposerOpen, setCommitComposerOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const compareBaselineRef = useRef('');
  const diffEditorRef = useRef<import('monaco-editor').editor.IStandaloneDiffEditor | null>(null);
  const diffEditorListenerRef = useRef<import('monaco-editor').IDisposable | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/commits/${commitHash}${wsParam}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const nextCommit = (data.commit ?? null) as CommitDetail | null;
        setCommit(nextCommit);
        setSelectedFile((current) => {
          if (current && nextCommit?.files.some((file) => file.path === current)) {
            return current;
          }
          return workspace ? nextCommit?.files[0]?.path ?? null : null;
        });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [commitHash, workspace]);

  useEffect(() => {
    if (!selectedFile) {
      setCompareData(null);
      setEditContent('');
      setDirty(false);
      setSaveNote(null);
      return;
    }

    let cancelled = false;
    setCompareLoading(true);
    setSaveNote(null);
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';

    fetch(`/api/panel/commits/${commitHash}/file?path=${encodeURIComponent(selectedFile)}${wsParam}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const nextCompare = (data.file ?? null) as CommitFileCompare | null;
        setCompareData(nextCompare);
        const nextContent = nextCompare?.workspaceContent ?? nextCompare?.commitContent ?? '';
        compareBaselineRef.current = nextContent;
        setEditContent(nextContent);
        setDirty(false);
        setCompareLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setCompareData({
          path: selectedFile,
          status: 'unknown',
          commitContent: null,
          commitSource: null,
          workspaceContent: null,
          workspaceExists: false,
          note: err instanceof Error ? err.message : 'Unable to load file compare',
        });
        compareBaselineRef.current = '';
        setEditContent('');
        setDirty(false);
        setCompareLoading(false);
      });

    return () => { cancelled = true; };
  }, [commitHash, selectedFile, workspace]);

  const handleSave = useCallback(async () => {
    if (!workspace || !selectedFile || saving) return false;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: editContent, workspace }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? 'Save failed');
      }
      setCompareData((current) => current
        ? {
            ...current,
            workspaceContent: editContent,
            workspaceExists: true,
          }
        : current);
      compareBaselineRef.current = editContent;
      setDirty(false);
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(null), 2200);
      return true;
    } catch (err) {
      setSaveNote(`Error: ${err instanceof Error ? err.message : 'Save failed'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [editContent, saving, selectedFile, workspace]);

  const stageAndCommit = useCallback(async () => {
    if (!workspace || !commitMsg.trim() || commitLoading) return;
    setCommitLoading(true);
    setActionToast(null);
    try {
      if (dirty) {
        const saved = await handleSave();
        if (!saved) {
          setCommitLoading(false);
          return;
        }
      }
      const res = await fetch('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg, workspace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Commit failed');
      setActionToast({ type: 'success', message: data.message || `Committed ${data.hash ?? commitHash.slice(0, 7)}` });
      setCommitMsg('');
      setCommitComposerOpen(false);
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }, [commitHash, commitLoading, commitMsg, dirty, handleSave, workspace]);

  const handlePush = useCallback(async () => {
    if (!workspace || pushLoading || saving || commitLoading || dirty) return;
    setPushLoading(true);
    setActionToast(null);
    try {
      const res = await fetch('/api/review/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Push failed');
      setActionToast({
        type: 'success',
        message: data.message || `Pushed ${data.branch ?? 'branch'}${data.upstream ? ` to ${data.upstream}` : ''}`,
      });
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Push failed' });
    } finally {
      setPushLoading(false);
    }
  }, [commitLoading, dirty, pushLoading, saving, workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!selectedFile || !workspace) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave, selectedFile, workspace]);

  useEffect(() => () => {
    diffEditorListenerRef.current?.dispose();
  }, []);

  const handleDiffEditorMount = useCallback((editor: unknown) => {
    const diffEditor = editor as import('monaco-editor').editor.IStandaloneDiffEditor;
    diffEditorRef.current = diffEditor;
    diffEditorListenerRef.current?.dispose();
    const modifiedEditor = diffEditor.getModifiedEditor();
    diffEditorListenerRef.current = modifiedEditor.onDidChangeModelContent(() => {
      const value = modifiedEditor.getValue();
      setEditContent(value);
      setDirty(value !== compareBaselineRef.current);
    });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
        Loading commit…
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>
        Failed to load commit: {error || 'Unknown error'}
      </div>
    );
  }

  const fileDiffs = new Map<string, string>();
  if (commit.diff) {
    const sections = commit.diff.split(/^diff --git /m).filter(Boolean);
    for (const section of sections) {
      const firstLine = section.split('\n')[0] ?? '';
      const match = firstLine.match(/b\/(.+)$/);
      if (match) {
        fileDiffs.set(match[1], 'diff --git ' + section);
      }
    }
  }

  const activeDiff = selectedFile ? (fileDiffs.get(selectedFile) ?? '') : commit.diff;
  const selectedFileEntry = selectedFile ? commit.files.find((file) => file.path === selectedFile) ?? null : null;
  const compareLanguage = selectedFile ? getMonacoLanguage(selectedFile) : 'plaintext';
  const editorTheme = themeId === 'light' ? 'cortex-frost' : 'cortex-graphite';
  const hasWorkspace = Boolean(workspace);
  const normalizedSelectedFilePath = selectedFile
    ? selectedFile.replace(/^\/+/, '').replace(/\s+/g, '-')
    : null;
  const originalModelPath = normalizedSelectedFilePath
    ? `/__cortex_commit__/${commit.hash}/${normalizedSelectedFilePath}`
    : undefined;
  const modifiedModelPath = normalizedSelectedFilePath
    ? `/__cortex_workspace__/${normalizedSelectedFilePath}`
    : undefined;
  const canEditSelectedFile = Boolean(
    workspace
    && selectedFile
    && (
      compareData?.workspaceExists
      || compareData?.commitContent !== null
    ),
  );
  const editorValue = compareData?.workspaceContent ?? compareData?.commitContent ?? editContent;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        paddingTop: 11,
        paddingRight: 16,
        paddingBottom: 9,
        paddingLeft: 16,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--t-text)',
            lineHeight: 1.35,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {commit.subject}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {saveNote ? (
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: saveNote.startsWith('Error') ? '#ef4444' : '#16a34a',
              }}>
                {saveNote}
              </span>
            ) : null}
            {hasWorkspace ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!selectedFile || !hasWorkspace || saving || !dirty}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--t-divider)',
                    background: dirty ? 'var(--t-panel-translucent)' : 'transparent',
                    color: dirty ? 'var(--t-text)' : 'var(--t-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: dirty ? 'pointer' : 'default',
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setCommitComposerOpen((current) => !current)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--t-divider)',
                    background: commitComposerOpen || commitMsg.trim() ? 'var(--t-panel-translucent)' : 'transparent',
                    color: commitComposerOpen || commitMsg.trim() ? 'var(--t-text)' : 'var(--t-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  <Check size={12} />
                  Commit
                </button>
                <button
                  type="button"
                  onClick={() => void handlePush()}
                  disabled={!hasWorkspace || pushLoading || saving || commitLoading || dirty}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--t-divider)',
                    background: pushLoading ? 'var(--t-panel-translucent)' : 'transparent',
                    color: pushLoading || (!dirty && !saving && !commitLoading) ? 'var(--t-text-secondary)' : 'var(--t-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: !dirty && !saving && !commitLoading ? 'pointer' : 'default',
                  }}
                >
                  <Send size={11} />
                  {pushLoading ? 'Pushing…' : 'Push'}
                </button>
              </>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                Read-only
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)', flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 10,
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 6,
            borderRadius: 999,
            background: 'var(--t-divider-subtle)',
            color: 'var(--t-text-muted)',
          }}>
            {commit.shortHash}
          </span>
          <span>{commit.author}</span>
          <span>·</span>
          <span>{formatAge(commit.date)}</span>
          <span>·</span>
          <span style={{ color: 'rgba(34,197,94,0.9)', fontWeight: 600 }}>+{commit.totalAdditions}</span>
          <span style={{ color: 'rgba(37,99,235,0.9)', fontWeight: 600 }}>-{commit.totalDeletions}</span>
          <span>{commit.files.length} file{commit.files.length !== 1 ? 's' : ''}</span>
        </div>
        {commit.body ? (
          <div style={{ marginTop: 5, fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
            {commit.body}
          </div>
        ) : null}
      </div>

      {hasWorkspace && commitComposerOpen ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          paddingRight: 16,
          paddingBottom: 8,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
        }}>
          <input
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(event) => setCommitMsg(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && commitMsg.trim()) {
                event.preventDefault();
                void stageAndCommit();
              }
              if (event.key === 'Escape') {
                setCommitComposerOpen(false);
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--t-divider)',
              borderRadius: 10,
              padding: '8px 11px',
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => void stageAndCommit()}
            disabled={!commitMsg.trim() || commitLoading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 12px',
              borderRadius: 10,
              border: '1px solid rgba(34,197,94,0.22)',
              background: commitMsg.trim() ? 'rgba(34,197,94,0.12)' : 'transparent',
              color: commitMsg.trim() ? '#16a34a' : 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 700,
              cursor: commitMsg.trim() ? 'pointer' : 'default',
            }}
          >
            <Check size={13} />
            {commitLoading ? 'Committing…' : 'Stage All + Commit'}
          </button>
          <button
            type="button"
            onClick={() => setCommitComposerOpen(false)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 10,
              border: '1px solid var(--t-divider)',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {actionToast ? (
        <div style={{
          paddingTop: 4,
          paddingRight: 20,
          paddingBottom: 4,
          paddingLeft: 20,
          fontSize: 11,
          fontWeight: 600,
          color: actionToast.type === 'success' ? '#16a34a' : '#ef4444',
          background: actionToast.type === 'success'
            ? 'rgba(34,197,94,0.06)'
            : 'rgba(239,68,68,0.08)',
          flexShrink: 0,
        }}>
          {actionToast.message}
        </div>
      ) : null}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid var(--t-divider)',
          overflowY: 'auto',
          background: 'var(--t-bg-subtle)',
        }}>
          <button
            type="button"
            onClick={() => setSelectedFile(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              paddingTop: 10,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 14,
              border: 'none',
              borderLeft: selectedFile === null ? '2px solid #2563eb' : '2px solid transparent',
              background: selectedFile === null ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 13,
              fontWeight: selectedFile === null ? 600 : 400,
              color: 'var(--t-text-strong)',
            }}
          >
            Overview ({commit.files.length})
          </button>

          {commit.files.map((file) => {
            const isActive = selectedFile === file.path;
            const fileName = file.path.split('/').pop() ?? file.path;
            const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedFile(file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  border: 'none',
                  borderLeft: isActive ? '2px solid #2563eb' : '2px solid transparent',
                  background: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1), border-left-color 100ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              >
                <DiffStatusIcon status={file.status ?? 'modified'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: 'var(--t-text-strong)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{fileName}</div>
                  {dirPath ? (
                    <div style={{
                      fontSize: 11,
                      color: 'var(--t-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{dirPath}</div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                  {(file.additions ?? 0) > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                  {(file.deletions ?? 0) > 0 ? <span style={{ color: '#2563eb' }}>-{file.deletions}</span> : null}
                </div>
                <ChevronRight size={12} strokeWidth={2} style={{ color: 'var(--t-text-faint)', flexShrink: 0 }} />
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {selectedFile ? (
            <>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 10,
                paddingRight: 16,
                paddingBottom: 10,
                paddingLeft: 16,
                borderBottom: '1px solid var(--t-divider-subtle)',
                background: 'var(--t-panel-translucent)',
                flexShrink: 0,
              }}>
                <FileText size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                  {selectedFileEntry?.path ?? selectedFile}
                </span>
                {selectedFileEntry ? (
                  <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>
                    +{selectedFileEntry.additions ?? 0}
                  </span>
                ) : null}
                {selectedFileEntry ? (
                  <span style={{ fontSize: 11, color: '#2563eb', fontWeight: 700 }}>
                    -{selectedFileEntry.deletions ?? 0}
                  </span>
                ) : null}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t-text-muted)' }}>
                  {compareData?.note ?? ''}
                </span>
              </div>

              <div style={{ flex: 1, minHeight: 0 }}>
                {compareLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
                    Loading live compare…
                  </div>
                ) : compareData && compareData.commitContent !== null && compareData.workspaceContent !== null ? (
                  <MonacoDiffEditor
                    height="100%"
                    language={compareLanguage}
                    original={compareData.commitContent}
                    modified={editContent}
                    originalModelPath={originalModelPath}
                    modifiedModelPath={modifiedModelPath}
                    keepCurrentOriginalModel
                    keepCurrentModifiedModel
                    theme={editorTheme}
                    beforeMount={defineCortexMonacoThemes}
                    onMount={handleDiffEditorMount}
                    options={{
                      readOnly: !canEditSelectedFile,
                      originalEditable: false,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      lineNumbers: 'on',
                      padding: { top: 12, bottom: 12 },
                      overviewRulerBorder: false,
                      glyphMargin: false,
                      scrollbar: {
                        vertical: 'hidden',
                        horizontal: 'auto',
                        verticalScrollbarSize: 0,
                        horizontalScrollbarSize: 8,
                        useShadows: false,
                      },
                    }}
                  />
                ) : (
                  <MonacoEditor
                    height="100%"
                    language={compareLanguage}
                    value={editorValue}
                    theme={editorTheme}
                    beforeMount={defineCortexMonacoThemes}
                    onChange={(value) => {
                      if (!canEditSelectedFile || value === undefined) return;
                      setEditContent(value);
                      setDirty(value !== (compareData?.workspaceContent ?? compareData?.commitContent ?? ''));
                    }}
                    options={{
                      readOnly: !canEditSelectedFile,
                      fontSize: 13,
                      fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
                      lineHeight: 20,
                      tabSize: 2,
                      insertSpaces: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      lineNumbers: 'on',
                      padding: { top: 12, bottom: 12 },
                      glyphMargin: false,
                      overviewRulerLanes: 0,
                      overviewRulerBorder: false,
                      scrollbar: {
                        vertical: 'hidden',
                        horizontal: 'auto',
                        verticalScrollbarSize: 0,
                        horizontalScrollbarSize: 8,
                        useShadows: false,
                      },
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <pre style={{
                margin: 0,
                paddingTop: 14,
                paddingRight: 16,
                paddingBottom: 14,
                paddingLeft: 16,
                fontSize: '0.8rem',
                lineHeight: 1.65,
                fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--t-text-strong)',
              }}>
                {renderDiffLines(activeDiff)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
