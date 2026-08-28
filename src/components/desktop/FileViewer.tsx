'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps -- extracted from Canvas.tsx */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from './lucide-shims';
import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';
import { useTheme } from '@/lib/theme/context';
import { renderDiffLines } from './diff-utils';
import { MODEL_IDS } from '@/lib/models';
import { SaveConflictStrip, type SaveConflict } from './SaveConflictStrip';
import { defineCortexMonacoThemes, getMonacoLanguage } from './file-viewer-monaco';

export { defineCortexMonacoThemes, getMonacoLanguage };

const MonacoEditor = dynamic(() => import('@/lib/monaco-polyfills').then(() =>
  import('@monaco-editor/react').then((mod) => mod.default)
), {
  ssr: false,
  loading: () => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading editor…</div>,
});

// ── File Viewer ──

export const FileViewer = memo(function FileViewer({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const { themeId } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>('');
  const [diff, setDiff] = useState<string>('');
  const [hasDiff, setHasDiff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null);
  const [activeView, setActiveView] = useState<'content' | 'diff'>('content');
  const [editing, setEditing] = useState(true); // Always editable — click in, start typing
  const editorRef = useRef<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDirty(false);
    setSaveNote(null);
    setSaveConflict(null);
    setFileHash(null);

    // Fetch file content
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    Promise.all([
      fetch(`/api/panel/file-content?path=${encodeURIComponent(filePath)}${wsParam}`)
        .then(r => r.json()).catch(() => ({ content: null })),
      fetch(`/api/panel/file-diff?path=${encodeURIComponent(filePath)}${wsParam}`)
        .then(r => r.json()).catch(() => ({ diff: '', hasDiff: false })),
    ]).then(([contentData, diffData]) => {
      if (!cancelled) {
        setContent(contentData.content ?? null);
        setEditContent(contentData.content ?? '');
        setFileHash(typeof contentData.contentHash === 'string' ? contentData.contentHash : null);
        setDiff(diffData.diff ?? '');
        setHasDiff(diffData.hasDiff ?? false);
        if (diffData.hasDiff) setActiveView('diff');
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      tabCompleteDisposableRef.current?.dispose();
      tabCompleteAbortRef.current?.abort();
    };
  }, [filePath, workspace]);

  // Save file via API
  const handleSave = useCallback(async (force = false) => {
    if ((!dirty && !force) || saving || (saveConflict && !force)) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          content: editContent,
          workspace,
          ...(fileHash ? { expectedHash: fileHash } : {}),
          ...(force ? { force: true } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok) {
        setContent(editContent);
        setFileHash(typeof data.contentHash === 'string' ? data.contentHash : null);
        setSaveConflict(null);
        setDirty(false);
        setSaveNote('Saved');
        setTimeout(() => setSaveNote(null), 2000);
      } else if (res.status === 409 && data.error === 'changed-on-disk') {
        setSaveConflict({
          content: typeof data.content === 'string' ? data.content : null,
          contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
        });
      } else {
        setSaveNote(`Error: ${typeof data.error === 'string' ? data.error : 'Save failed'}`);
      }
    } catch (err) {
      setSaveNote(`Error: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, saveConflict, filePath, editContent, workspace, fileHash]);

  const reloadConflict = useCallback(() => {
    if (!saveConflict) return;
    setContent(saveConflict.content);
    setEditContent(saveConflict.content ?? '');
    setFileHash(saveConflict.contentHash);
    setSaveConflict(null);
    setDirty(false);
    setSaveNote(null);
  }, [saveConflict]);

  // Cmd+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && editing) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editing, handleSave]);

  // Inline edit state
  const [inlineEditOpen, setInlineEditOpen] = useState(false);
  const [inlineEditPrompt, setInlineEditPrompt] = useState('');
  const [inlineEditLoading, setInlineEditLoading] = useState(false);
  const [inlineEditResponse, setInlineEditResponse] = useState('');
  const [inlineEditMode, setInlineEditMode] = useState<'edit' | 'explain'>('edit');
  const [inlineEditAgent, setInlineEditAgent] = useState<'flash' | 'sonnet' | 'opus'>('flash');
  // Diff preview for accept/reject
  const [pendingDiff, setPendingDiff] = useState<{ original: string; modified: string; selection: import('monaco-editor').IRange | null; isFullFile: boolean } | null>(null);
  // Prompt history
  const [promptHistory] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('cortex.inline-edit-history') ?? '[]'); } catch { return []; }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inlineEditInputRef = useRef<HTMLInputElement>(null);
  const inlineWidgetRef = useRef<{ dispose: () => void } | null>(null);
  const inlineWidgetDomRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const cursorLineRef = useRef(1);

  // Tab completion abort controller
  const tabCompleteAbortRef = useRef<AbortController | null>(null);
  const tabCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabCompleteDisposableRef = useRef<{ dispose: () => void } | null>(null);

  // Monaco editor mount handler
  const handleEditorMount = useCallback((editor: unknown) => {
    editorRef.current = editor;

    loader.init().then((monaco) => {
      monacoRef.current = monaco;
      const ed = editor as import('monaco-editor').editor.IStandaloneCodeEditor;

      // Cmd+S — save
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void handleSave();
      });

      // Track cursor line for widget positioning
      ed.onDidChangeCursorPosition((e) => {
        cursorLineRef.current = e.position.lineNumber;
      });

      // Cmd+E — inline AI edit widget
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => {
        const pos = ed.getPosition();
        if (pos) cursorLineRef.current = pos.lineNumber;

        // Remove existing widget
        if (inlineWidgetRef.current) {
          inlineWidgetRef.current.dispose();
          inlineWidgetRef.current = null;
        }

        // Create widget DOM
        if (!inlineWidgetDomRef.current) {
          inlineWidgetDomRef.current = document.createElement('div');
          inlineWidgetDomRef.current.id = 'cortex-inline-widget';
        }

        const lineNumber = cursorLineRef.current;
        const widget = {
          getId: () => 'cortex.inline.edit',
          getDomNode: () => inlineWidgetDomRef.current!,
          getPosition: () => ({
            position: { lineNumber, column: 1 },
            preference: [monaco.editor.ContentWidgetPositionPreference.BELOW],
          }),
        };

        ed.addContentWidget(widget);
        inlineWidgetRef.current = { dispose: () => ed.removeContentWidget(widget) };

        setInlineEditOpen(true);
        setInlineEditResponse('');
        setInlineEditMode('edit');
        setTimeout(() => inlineEditInputRef.current?.focus(), 80);
      });

      // Tab autocomplete — disabled for now (Monaco internal lifecycle crash)
      // Will re-enable with a debounced widget approach instead of inline provider
    });
  }, [handleSave, filePath]);

  // Agent model mapping
  const agentModels: Record<string, { provider: string; model: string }> = {
    flash: { provider: 'google', model: MODEL_IDS.mobileGeminiDefault },
    sonnet: { provider: 'anthropic', model: MODEL_IDS.claudeWorkerDefault },
    opus: { provider: 'anthropic', model: MODEL_IDS.orchestratorDefault },
  };

  // Handle inline edit submission
  const handleInlineEdit = useCallback(async () => {
    const ed = editorRef.current as import('monaco-editor').editor.IStandaloneCodeEditor | null;
    if (!ed || !inlineEditPrompt.trim() || inlineEditLoading) return;

    const selection = ed.getSelection();
    const model = ed.getModel();
    if (!model) return;

    const selectedText = selection && !selection.isEmpty()
      ? model.getValueInRange(selection)
      : model.getValue();
    const isFullFile = !selection || selection.isEmpty();
    const language = getMonacoLanguage(filePath);

    // Detect mode: if prompt starts with "explain" or "?", use explain mode
    const trimmed = inlineEditPrompt.trim();
    const isExplain = /^(explain|what|why|how|\?)/.test(trimmed.toLowerCase());
    setInlineEditMode(isExplain ? 'explain' : 'edit');
    setInlineEditLoading(true);
    setInlineEditResponse('');

    const { provider, model: llmModel } = agentModels[inlineEditAgent];
    const systemPrompt = isExplain
      ? `You are a senior developer explaining code. Be concise (max 4 sentences). No markdown fences.`
      : `You are a code editor. Output ONLY modified code. No explanations. No markdown fences. No conversation. If the instruction is unclear, return the code unchanged.`;

    const userContent = isExplain
      ? `${trimmed}\n\nCODE:\n${selectedText}`
      : `Rewrite this ${language} code to: ${trimmed}\n\nSELECTED CODE:\n${selectedText}`;

    try {
      const res = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: llmModel,
          messages: [
            { role: 'user', content: `${systemPrompt}\n\n${userContent}` },
          ],
          max_tokens: 4096,
        }),
      });

      if (!res.ok) throw new Error('LLM request failed');

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let result = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event.type === 'content' || event.type === 'delta') {
              result += (event.text ?? '') as string;
              // Stream response into the widget
              if (isExplain) setInlineEditResponse(result);
            }
          } catch { /* skip */ }
        }
      }

      if (isExplain) {
        // Just show the explanation — don't modify code
        setInlineEditResponse(result.trim());
        setInlineEditLoading(false);
        return;
      }

      if (result.trim()) {
        let cleaned = result.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        }

        // Show diff preview — don't auto-apply
        setPendingDiff({
          original: selectedText,
          modified: cleaned,
          selection: isFullFile ? null : (selection ?? null),
          isFullFile,
        });
      }

      // Save to history
      const prompt = inlineEditPrompt.trim();
      if (prompt) {
        const newHistory = [prompt, ...promptHistory.filter(h => h !== prompt)].slice(0, 10);
        promptHistory.splice(0, promptHistory.length, ...newHistory);
        localStorage.setItem('cortex.inline-edit-history', JSON.stringify(newHistory));
      }
    } catch (err) {
      setInlineEditResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setInlineEditLoading(false);
    }
  }, [inlineEditPrompt, inlineEditLoading, inlineEditAgent, filePath, content, promptHistory]);

  // Accept the pending diff
  const handleAcceptDiff = useCallback(() => {
    const ed = editorRef.current as import('monaco-editor').editor.IStandaloneCodeEditor | null;
    if (!ed || !pendingDiff) return;
    const model = ed.getModel();
    if (!model) return;

    if (pendingDiff.isFullFile) {
      const fullRange = model.getFullModelRange();
      ed.executeEdits('cortex-inline-edit', [{ range: fullRange, text: pendingDiff.modified }]);
    } else if (pendingDiff.selection) {
      ed.executeEdits('cortex-inline-edit', [{ range: pendingDiff.selection, text: pendingDiff.modified }]);
    }

    setEditContent(model.getValue());
    setDirty(model.getValue() !== content);
    setPendingDiff(null);
    setInlineEditOpen(false);
    setInlineEditPrompt('');
    inlineWidgetRef.current?.dispose();
    inlineWidgetRef.current = null;
  }, [pendingDiff, content]);

  // Reject the pending diff
  const handleRejectDiff = useCallback(() => {
    setPendingDiff(null);
  }, []);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading file…</div>;
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  const lineCount = (editing ? editContent : content ?? '').split('\n').length;
  const fileSize = new Blob([content ?? '']).size;
  const fileSizeLabel = fileSize > 1024 ? `${(fileSize / 1024).toFixed(1)} KB` : `${fileSize} B`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}>
        <FileText size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>
          {fileName}{dirty ? ' •' : ''}
        </span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>{filePath}</span>
        <span style={{ fontSize: 10, color: 'var(--t-text-muted)', opacity: 0.7 }}>{lineCount} lines · {fileSizeLabel}</span>

        {saveNote ? (
          <span style={{
            fontSize: 11,
            fontWeight: 500,
            color: saveNote.startsWith('Error') ? '#ef4444' : '#22c55e',
            marginLeft: 8,
          }}>{saveNote}</span>
        ) : null}

        {/* Save indicator — shows inline when dirty */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {dirty ? (
            <span style={{
              fontSize: 11, fontWeight: 500,
              color: saving ? 'var(--t-text-muted)' : '#b45309',
            }}>
              {saving ? 'Saving…' : '⌘S to save'}
            </span>
          ) : null}
        </div>

        {hasDiff && !editing ? (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {(['content', 'diff'] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setActiveView(view)}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 11,
                  fontWeight: activeView === view ? 600 : 400,
                  color: activeView === view ? '#2563eb' : 'var(--t-text-secondary)',
                  background: activeView === view ? 'rgba(37,99,235,0.08)' : 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                {view === 'content' ? 'Content' : 'Diff'}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {saveConflict ? (
        <SaveConflictStrip
          busy={saving}
          onReload={reloadConflict}
          onOverwrite={() => { void handleSave(true); }}
        />
      ) : null}

      {/* Inline Edit Widget — renders into Monaco content widget via portal */}
      {inlineEditOpen && inlineWidgetDomRef.current && createPortal(
        <div style={{
          width: 420,
          borderRadius: 14,
          border: '1px solid rgba(99, 102, 241, 0.2)',
          background: 'rgba(248, 250, 255, 0.92)',
          backdropFilter: 'blur(20px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(99,102,241,0.06)',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 9999,
          fontFamily: 'var(--font-sans-system)',
        }}>
          {/* Agent picker pills */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: '#6366f1', fontWeight: 600, marginRight: 4 }}>✨</span>
            {(['flash', 'sonnet', 'opus'] as const).map((agent) => (
              <button
                key={agent}
                type="button"
                onClick={() => setInlineEditAgent(agent)}
                style={{
                  padding: '2px 8px', borderRadius: 6, border: 'none',
                  fontSize: 10, fontWeight: inlineEditAgent === agent ? 600 : 400,
                  color: inlineEditAgent === agent ? '#fff' : '#64748b',
                  background: inlineEditAgent === agent
                    ? (agent === 'flash' ? '#6366f1' : agent === 'sonnet' ? '#2563eb' : '#7c3aed')
                    : 'rgba(148,163,184,0.1)',
                  cursor: 'pointer',
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  textTransform: 'capitalize',
                }}
              >
                {agent}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 9, color: '#94a3b8' }}>⌘E</span>
          </div>

          {/* Input */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              ref={inlineEditInputRef}
              type="text"
              value={inlineEditPrompt}
              onChange={(e) => setInlineEditPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && inlineEditPrompt.trim()) {
                  e.preventDefault();
                  setPendingDiff(null);
                  void handleInlineEdit();
                }
                if (e.key === 'Escape') {
                  setInlineEditOpen(false);
                  setInlineEditPrompt('');
                  setInlineEditResponse('');
                  setPendingDiff(null);
                  inlineWidgetRef.current?.dispose();
                  inlineWidgetRef.current = null;
                }
                // Arrow up/down for prompt history
                if (e.key === 'ArrowUp' && promptHistory.length > 0) {
                  e.preventDefault();
                  const next = Math.min(historyIndex + 1, promptHistory.length - 1);
                  setHistoryIndex(next);
                  setInlineEditPrompt(promptHistory[next]);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (historyIndex <= 0) {
                    setHistoryIndex(-1);
                    setInlineEditPrompt('');
                  } else {
                    const next = historyIndex - 1;
                    setHistoryIndex(next);
                    setInlineEditPrompt(promptHistory[next]);
                  }
                }
              }}
              placeholder={inlineEditLoading ? 'Thinking…' : '"add error handling" or "explain this"'}
              disabled={inlineEditLoading}
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid rgba(99, 102, 241, 0.15)',
                background: 'rgba(255,255,255,0.7)',
                fontSize: 12,
                color: '#1e293b',
                outline: 'none',
              }}
            />
            {inlineEditLoading ? (
              <div style={{ width: 14, height: 14, border: '2px solid #6366f1', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setInlineEditOpen(false); setInlineEditPrompt(''); setInlineEditResponse('');
                  inlineWidgetRef.current?.dispose(); inlineWidgetRef.current = null;
                }}
                style={{
                  padding: '4px 6px', border: 'none', background: 'transparent',
                  color: '#94a3b8', fontSize: 10, cursor: 'pointer', fontWeight: 500,
                }}
              >
                esc
              </button>
            )}
          </div>

          {/* Response area (explain mode or error) */}
          {/* Response area (explain mode or error) */}
          {inlineEditResponse ? (
            <div style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: inlineEditResponse.startsWith('Error')
                ? 'rgba(239,68,68,0.06)'
                : 'rgba(99,102,241,0.04)',
              border: `1px solid ${inlineEditResponse.startsWith('Error') ? 'rgba(239,68,68,0.15)' : 'rgba(99,102,241,0.1)'}`,
              fontSize: 11,
              lineHeight: 1.5,
              color: inlineEditResponse.startsWith('Error') ? '#dc2626' : '#334155',
              maxHeight: 120,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {inlineEditResponse}
            </div>
          ) : null}

          {/* Diff preview + Accept/Reject */}
          {pendingDiff ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{
                maxHeight: 160,
                overflowY: 'auto',
                borderRadius: 8,
                border: '1px solid rgba(99,102,241,0.1)',
                fontSize: 11,
                fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
                lineHeight: 1.6,
              }}>
                {(() => {
                  const origLines = pendingDiff.original.split('\n');
                  const modLines = pendingDiff.modified.split('\n');
                  const maxLen = Math.max(origLines.length, modLines.length);
                  const diffLines: Array<{ text: string; type: 'same' | 'add' | 'remove' }> = [];
                  for (let i = 0; i < maxLen; i++) {
                    const orig = origLines[i] ?? '';
                    const mod = modLines[i] ?? '';
                    if (i >= origLines.length) {
                      diffLines.push({ text: mod, type: 'add' });
                    } else if (i >= modLines.length) {
                      diffLines.push({ text: orig, type: 'remove' });
                    } else if (orig !== mod) {
                      diffLines.push({ text: orig, type: 'remove' });
                      diffLines.push({ text: mod, type: 'add' });
                    } else {
                      diffLines.push({ text: orig, type: 'same' });
                    }
                  }
                  return diffLines.map((line, i) => (
                    <div key={i} style={{
                      padding: '0 8px',
                      background: line.type === 'add' ? 'rgba(34,197,94,0.08)'
                        : line.type === 'remove' ? 'rgba(239,68,68,0.06)'
                        : 'transparent',
                      color: line.type === 'add' ? '#16a34a'
                        : line.type === 'remove' ? '#dc2626'
                        : '#64748b',
                      textDecoration: line.type === 'remove' ? 'line-through' : 'none',
                      opacity: line.type === 'remove' ? 0.7 : 1,
                    }}>
                      <span style={{ display: 'inline-block', width: 14, color: '#94a3b8', userSelect: 'none' }}>
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
                      </span>
                      {line.text || ' '}
                    </div>
                  ));
                })()}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={handleAcceptDiff}
                  style={{
                    flex: 1, padding: '6px 0', borderRadius: 8,
                    border: '1px solid rgba(34,197,94,0.3)',
                    background: 'rgba(34,197,94,0.06)',
                    color: '#16a34a', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  ✓ Accept
                </button>
                <button
                  type="button"
                  onClick={handleRejectDiff}
                  style={{
                    flex: 1, padding: '6px 0', borderRadius: 8,
                    border: '1px solid rgba(239,68,68,0.2)',
                    background: 'transparent',
                    color: '#dc2626', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                  }}
                >
                  ✗ Reject
                </button>
              </div>
            </div>
          ) : null}
        </div>,
        inlineWidgetDomRef.current,
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeView === 'diff' && hasDiff && !editing ? (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <pre style={{
              margin: 0,
              paddingTop: 14,
              paddingRight: 16,
              paddingBottom: 14,
              paddingLeft: 16,
              fontSize: '0.8rem',
              lineHeight: 1.65,
              fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--t-text-strong)',
            }}>
              {renderDiffLines(diff)}
            </pre>
          </div>
        ) : content !== null ? (
          <MonacoEditor
            height="100%"
            language={getMonacoLanguage(filePath)}
            value={editContent}
            theme={themeId === 'light' ? 'cortex-frost' : 'cortex-graphite'}
            onChange={(value) => {
              if (editing && value !== undefined) {
                setEditContent(value);
                setDirty(value !== content);
              }
            }}
            onMount={handleEditorMount}
            beforeMount={defineCortexMonacoThemes}
            options={{
              readOnly: false,
              fontSize: 13,
              fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
              lineHeight: 20,
              tabSize: 2,
              insertSpaces: true,
              minimap: { enabled: true, maxColumn: 80, scale: 2 },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              glyphMargin: false,
              folding: true,
              bracketPairColorization: { enabled: true },
              renderLineHighlight: 'line',
              occurrencesHighlight: 'singleFile',
              matchBrackets: 'always',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 12, bottom: 12 },
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              scrollbar: {
                vertical: 'hidden',
                horizontal: 'auto',
                verticalScrollbarSize: 0,
                horizontalScrollbarSize: 8,
                useShadows: false,
              },
              contextmenu: true,
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              parameterHints: { enabled: false },
              inlineSuggest: { enabled: false }, // re-enable when tab autocomplete is stabilized
              renderWhitespace: 'selection',
              guides: { bracketPairs: true, indentation: true },
            }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
            Could not load file content
          </div>
        )}
      </div>
    </div>
  );
});
