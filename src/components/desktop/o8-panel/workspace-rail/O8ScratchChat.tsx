'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowBendUpRight,
  ArrowsInSimple,
  ArrowsOutSimple,
  Article,
  PaperPlaneTilt,
  Trash,
  X,
} from '@phosphor-icons/react';
import { MarkdownRender } from '../markdown-render';
import { useOrchestratorData } from '../../orchestrator-data-context';

const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const O8_ICON_ACTIVE = 'var(--t-chat-surface-text, #0f172a)';
const O8_ICON_INACTIVE = 'var(--t-chat-surface-text-secondary, #64748b)';
const SCRATCH_LOCAL_TOKENS: CSSProperties = {
  ['--o8-scratch-surface' as string]: 'var(--t-chat-surface-bg, #f4f2ed)',
  ['--o8-scratch-card' as string]: 'var(--t-chat-surface-card-bg, rgba(15, 23, 42, 0.04))',
  ['--o8-scratch-input' as string]: 'var(--t-chat-surface-input-bg, #f4f2ed)',
  ['--o8-scratch-border' as string]: 'var(--t-chat-surface-border, rgba(15, 23, 42, 0.1))',
  ['--o8-scratch-input-border' as string]: 'var(--t-chat-surface-input-border, rgba(15, 23, 42, 0.12))',
  ['--o8-scratch-text' as string]: 'var(--t-chat-surface-text, #0f172a)',
  ['--o8-scratch-muted' as string]: 'var(--t-chat-surface-text-secondary, #64748b)',
  ['--o8-scratch-faint' as string]: 'var(--t-chat-surface-text-muted, #94a3b8)',
  ['--o8-scratch-action' as string]: 'var(--t-chat-surface-text-secondary, #475569)',
  ['--t-panel' as string]: 'var(--o8-scratch-surface)',
  ['--t-panel-solid' as string]: 'var(--o8-scratch-surface)',
  ['--t-bg-subtle' as string]: 'var(--o8-scratch-card)',
  ['--t-input-bg' as string]: 'var(--o8-scratch-input)',
  ['--t-input-border' as string]: 'var(--o8-scratch-input-border)',
  ['--t-panel-border' as string]: 'var(--o8-scratch-border)',
  ['--t-divider-subtle' as string]: 'var(--o8-scratch-border)',
  ['--t-text' as string]: 'var(--o8-scratch-text)',
  ['--t-text-muted' as string]: 'var(--o8-scratch-muted)',
  ['--t-text-faint' as string]: 'var(--o8-scratch-faint)',
};
const BINARY_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpg',
  'jpeg',
  'pdf',
  'png',
  'webp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'zip',
]);

type ScratchRole = 'user' | 'assistant';
type ScratchSurface = 'file' | 'diff';

interface ScratchMessage {
  id: string;
  role: ScratchRole;
  content: string;
}

interface ScratchContext {
  repoPath?: string;
  filePath?: string;
  surface: ScratchSurface;
  selection?: string;
  content?: string;
}

type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

function extensionForPath(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

function canLoadFileContext(path: string) {
  return !BINARY_EXTENSIONS.has(extensionForPath(path));
}

function selectedTextFromActiveElement() {
  if (typeof document === 'undefined') return '';
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (active?.dataset.o8ScratchInput === 'true') return '';
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return start !== end ? active.value.slice(start, end).trim() : '';
  }
  return window.getSelection?.()?.toString().trim() ?? '';
}

function parseSseBlock(block: string): StreamEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n')
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

function compactPath(path?: string | null) {
  if (!path) return 'No file';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function AskO8Icon({ size = 16, color = O8_ICON_INACTIVE }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}
    >
      <path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7-1.7 4.8-1.7-4.8-4.8-1.7 4.8-1.7L12 3.5z" />
      <path d="M19 15l.7 2 .3.3 2 .7-2 .7-.3.3-.7 2-.7-2-.3-.3-2-.7 2-.7.3-.3.7-2z" />
    </svg>
  );
}

function buildHandoffDraft({
  messages,
  repoPath,
  selectedFile,
  surface,
}: {
  messages: ScratchMessage[];
  repoPath?: string | null;
  selectedFile?: string | null;
  surface: ScratchSurface;
}) {
  const relevantMessages = messages.slice(-6);
  const transcript = relevantMessages
    .map((message) => `${message.role === 'user' ? 'Operator' : 'o8 scratch'}: ${message.content.trim()}`)
    .filter(Boolean)
    .join('\n\n');

  return [
    'Use this O8 scratch conversation as context. It is read-only context only; no files were edited or saved from the scratch panel.',
    '',
    `Repo: ${repoPath ?? 'unknown'}`,
    `File: ${selectedFile ?? 'none'}`,
    `Surface: ${surface}`,
    '',
    transcript,
  ].join('\n');
}

async function readPanelContext({
  repoPath,
  selectedFile,
  surface,
  selection,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  surface: ScratchSurface;
  selection: string;
}): Promise<ScratchContext> {
  if (!repoPath || !selectedFile) {
    return { surface, selection };
  }

  if (surface === 'diff') {
    const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
    const response = await fetch(`/api/panel/file-diff?${params.toString()}`);
    const data = await response.json().catch(() => ({})) as { diff?: string; stagedDiff?: string; error?: string };
    return {
      repoPath,
      filePath: selectedFile,
      surface,
      selection,
      content: data.error ? `Diff unavailable: ${data.error}` : data.diff ?? data.stagedDiff ?? '',
    };
  }

  if (!canLoadFileContext(selectedFile)) {
    return {
      repoPath,
      filePath: selectedFile,
      surface,
      selection,
      content: `${extensionForPath(selectedFile).toUpperCase() || 'Binary'} file selected. No text source was sent.`,
    };
  }

  const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
  const response = await fetch(`/api/v2/files?${params.toString()}`);
  const data = await response.json().catch(() => ({})) as { content?: string; error?: string };
  return {
    repoPath,
    filePath: selectedFile,
    surface,
    selection,
    content: data.error ? `File unavailable: ${data.error}` : data.content ?? '',
  };
}

function HeaderButton({
  active,
  disabled,
  onOpen,
}: {
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={disabled ? 'Select a file to ask o8' : 'Ask o8 about this file (Cmd+E)'}
      aria-label="Ask o8"
      aria-disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      style={{
        width: 32,
        height: 32,
        padding: 0,
        border: active ? '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.26))' : '1px solid var(--t-chat-surface-input-border, rgba(15, 23, 42, 0.12))',
        borderRadius: 10,
        background: active ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.1))' : 'var(--t-chat-surface-card-bg, rgba(15, 23, 42, 0.04))',
        color: active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE,
        cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 0,
        flexShrink: 0,
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        position: 'relative',
        WebkitTapHighlightColor: 'transparent',
        opacity: disabled ? 0.62 : 1,
        boxShadow: active ? '0 0 0 3px rgba(96, 165, 250, 0.14)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.28)',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(event) => {
        if (!active && !disabled) {
          event.currentTarget.style.background = 'var(--t-accent-soft, rgba(37, 99, 235, 0.1))';
          event.currentTarget.style.borderColor = 'var(--t-accent-border, rgba(37, 99, 235, 0.26))';
        }
      }}
      onMouseLeave={(event) => {
        if (!active) {
          event.currentTarget.style.background = 'var(--t-chat-surface-card-bg, rgba(15, 23, 42, 0.04))';
          event.currentTarget.style.borderColor = 'var(--t-chat-surface-input-border, rgba(15, 23, 42, 0.12))';
        }
      }}
    >
      <AskO8Icon size={16} color={active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE} />
    </button>
  );
}

export function O8ScratchChat({
  repoPath,
  selectedFile,
  surface,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  surface: ScratchSurface;
}) {
  const data = useOrchestratorData();
  const buttonRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ScratchMessage[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [selectionSnapshot, setSelectionSnapshot] = useState('');
  const [panelPosition, setPanelPosition] = useState({ top: 0, right: 12 });
  const disabled = !repoPath || !selectedFile;

  const scopeLabel = useMemo(() => compactPath(selectedFile), [selectedFile]);

  const syncPanelPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPosition({
      top: Math.min(rect.bottom + 8, window.innerHeight - 120),
      right: Math.max(12, window.innerWidth - rect.right),
    });
  }, []);

  const openPanel = useCallback(() => {
    if (disabled) return;
    setSelectionSnapshot(selectedTextFromActiveElement());
    setOpen(true);
    setError(null);
    setHandoffNote(null);
    requestAnimationFrame(() => {
      syncPanelPosition();
      inputRef.current?.focus();
    });
  }, [disabled, syncPanelPosition]);

  const togglePanel = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    openPanel();
  }, [open, openPanel]);

  useEffect(() => {
    if (!open) return;
    syncPanelPosition();
    window.addEventListener('resize', syncPanelPosition);
    window.addEventListener('scroll', syncPanelPosition, true);
    return () => {
      window.removeEventListener('resize', syncPanelPosition);
      window.removeEventListener('scroll', syncPanelPosition, true);
    };
  }, [open, syncPanelPosition]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'e') return;
      const target = event.target as HTMLElement | null;
      if (target?.dataset.o8ScratchInput === 'true') return;
      if (!buttonRef.current?.getClientRects().length) return;
      event.preventDefault();
      togglePanel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePanel]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setInput('');
    setSending(false);
    setSummaryLoading(false);
    setError(null);
    setHandoffNote(null);
  }, []);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || sending) return;

    const userMessage: ScratchMessage = {
      id: `o8-scratch-user-${Date.now()}`,
      role: 'user',
      content: question,
    };
    const assistantId = `o8-scratch-assistant-${Date.now() + 1}`;
    const assistantMessage: ScratchMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
    };
    const nextMessages = [...messages, userMessage, assistantMessage];
    const selection = selectedTextFromActiveElement() || selectionSnapshot;

    setMessages(nextMessages);
    setInput('');
    setError(null);
    setHandoffNote(null);
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const context = await readPanelContext({
        repoPath,
        selectedFile,
        surface,
        selection,
      });

      const response = await fetch('/api/panel/o8-scratch-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: question,
          history: messages.map((message) => ({ role: message.role, content: message.content })),
          context,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `Scratch chat failed (${response.status}).`);
      }
      if (!response.body) {
        throw new Error('Scratch chat did not return a stream.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const event = parseSseBlock(block);
          if (!event) continue;
          if (event.type === 'content') {
            setMessages((current) => current.map((message) => (
              message.id === assistantId
                ? { ...message, content: `${message.content}${event.text}` }
                : message
            )));
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Scratch chat failed.');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setSending(false);
    }
  }, [input, messages, repoPath, selectedFile, selectionSnapshot, sending, surface]);

  const addToOrchestrator = useCallback(() => {
    if (!data?.onAcceptDirectiveProposal || messages.length === 0) return;
    data.onAcceptDirectiveProposal({
      id: `o8-scratch-handoff-${Date.now()}`,
      text: buildHandoffDraft({ messages, repoPath, selectedFile, surface }),
    });
    setHandoffNote('Added to orchestrator draft.');
  }, [data, messages, repoPath, selectedFile, surface]);

  const summarizeGithub = useCallback(async () => {
    if (!repoPath || summaryLoading) return;
    const assistantId = `o8-github-summary-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
      },
    ]);
    setError(null);
    setHandoffNote(null);
    setSummaryLoading(true);

    try {
      const response = await fetch('/api/panel/o8-github-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, limit: 12 }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        repo?: string;
        summary?: string;
      };
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `GitHub summary failed (${response.status}).`);
      }
      const content = [
        `### GitHub activity${payload.repo ? ` / ${payload.repo}` : ''}`,
        '',
        payload.summary?.trim() || 'No GitHub activity summary was returned.',
      ].join('\n');
      setMessages((current) => current.map((message) => (
        message.id === assistantId ? { ...message, content } : message
      )));
    } catch (err) {
      setMessages((current) => current.filter((message) => message.id !== assistantId));
      setError(err instanceof Error ? err.message : 'Unable to summarize GitHub activity.');
    } finally {
      setSummaryLoading(false);
    }
  }, [repoPath, summaryLoading]);

  return (
    <>
      <div ref={buttonRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <HeaderButton active={open} disabled={disabled && !open} onOpen={togglePanel} />
      </div>
      {open ? (
        <div
          role="dialog"
          aria-label="Ask o8"
          style={{
            ...SCRATCH_LOCAL_TOKENS,
            position: 'fixed',
            top: panelPosition.top,
            right: panelPosition.right,
            width: expanded ? 'min(760px, calc(100vw - 32px))' : 'min(420px, calc(100vw - 24px))',
            maxHeight: expanded ? 'min(780px, calc(100vh - 72px))' : 'min(590px, calc(100vh - 96px))',
            borderRadius: 18,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--o8-scratch-border)',
            background: 'var(--o8-scratch-surface)',
            color: 'var(--o8-scratch-text)',
            boxShadow: 'var(--t-panel-shadow), 0 22px 70px rgba(15, 23, 42, 0.18)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            zIndex: 200,
            fontFamily: UI_FONT,
          }}
        >
          <div style={{ minHeight: 46, display: 'flex', alignItems: 'center', gap: 9, borderBottom: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 12 }}>
            <div style={{ width: 25, height: 25, borderRadius: 9, background: 'var(--t-accent-soft)', color: 'var(--t-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <AskO8Icon size={14} color="var(--t-accent)" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--t-text)', fontSize: 12, fontWeight: 800, lineHeight: '16px' }}>Ask o8</div>
              <div style={{ color: 'var(--t-text-muted)', fontFamily: MONO_FONT, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {surface} / {scopeLabel}
              </div>
            </div>
            <button
              type="button"
              title={expanded ? 'Compact chat' : 'Expand chat'}
              onClick={() => setExpanded((current) => !current)}
              style={iconButtonStyle}
            >
              {expanded ? (
                <ArrowsInSimple size={15} weight="bold" color="var(--o8-scratch-action)" />
              ) : (
                <ArrowsOutSimple size={15} weight="bold" color="var(--o8-scratch-action)" />
              )}
            </button>
            <button
              type="button"
              title="Clear scratch chat"
              onClick={clearConversation}
              style={textButtonStyle}
            >
              <Trash size={14} weight="bold" color="var(--o8-scratch-action)" />
              Clear
            </button>
            <button
              type="button"
              title="Close"
              onClick={() => setOpen(false)}
              style={iconButtonStyle}
            >
              <X size={15} weight="bold" color="var(--o8-scratch-action)" />
            </button>
          </div>

          <div ref={scrollRef} style={{ flex: 1, minHeight: expanded ? 300 : 170, maxHeight: expanded ? 560 : 380, overflow: 'auto', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
            {messages.length === 0 ? (
              <div style={{ borderRadius: 14, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, color: 'var(--t-text-muted)', fontSize: 12, lineHeight: '18px' }}>
                Ask about the current file or diff. This is read-only; edits go through the orchestrator.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    style={{
                      alignSelf: message.role === 'user' ? 'flex-end' : 'stretch',
                      maxWidth: message.role === 'user' ? '86%' : '100%',
                      borderRadius: message.role === 'user' ? '14px 14px 4px 14px' : 14,
                      border: message.role === 'assistant' ? '1px solid var(--t-divider-subtle)' : 'none',
                      background: message.role === 'user' ? 'var(--t-accent)' : 'var(--t-bg-subtle)',
                      color: message.role === 'user' ? 'var(--t-on-accent, #ffffff)' : 'var(--t-text)',
                      paddingTop: 9,
                      paddingRight: 10,
                      paddingBottom: 9,
                      paddingLeft: 10,
                      fontSize: 12,
                      lineHeight: '18px',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {message.role === 'assistant' ? (
                      message.content ? <MarkdownRender content={message.content} /> : <span style={{ color: 'var(--t-text-muted)' }}>Thinking...</span>
                    ) : (
                      message.content
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {error || handoffNote ? (
            <div style={{ borderTop: '1px solid var(--t-divider-subtle)', color: error ? 'var(--t-brand-red)' : 'var(--t-terminal-ansi-bright-green, #16a34a)', fontSize: 11, fontWeight: 700, paddingTop: 8, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }}>
              {error ?? handoffNote}
            </div>
          ) : null}

          <div style={{ borderTop: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
            <textarea
              ref={inputRef}
              data-o8-scratch-input="true"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask about this file or diff..."
              rows={3}
              style={{
                width: '100%',
                minHeight: 64,
                resize: 'none',
                border: '1px solid var(--t-divider-subtle)',
                borderRadius: 14,
                outline: 'none',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                fontFamily: UI_FONT,
                fontSize: 12,
                lineHeight: '18px',
                paddingTop: 9,
                paddingRight: 10,
                paddingBottom: 9,
                paddingLeft: 10,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => { void summarizeGithub(); }}
                disabled={!repoPath || summaryLoading}
                style={{
                  minHeight: 28,
                  borderRadius: 9,
                  border: '1px solid var(--t-divider-subtle)',
                  background: 'var(--t-input-bg)',
                  color: repoPath && !summaryLoading ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
                  cursor: repoPath && !summaryLoading ? 'pointer' : 'default',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: UI_FONT,
                  fontSize: 11,
                  fontWeight: 750,
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 9,
                }}
              >
                <Article size={14} />
                {summaryLoading ? 'Summarizing' : 'Summary'}
              </button>
              <button
                type="button"
                onClick={addToOrchestrator}
                disabled={!messages.length || !data?.onAcceptDirectiveProposal}
                style={{
                  minHeight: 28,
                  borderRadius: 9,
                  border: '1px solid var(--t-divider-subtle)',
                  background: 'var(--t-input-bg)',
                  color: messages.length ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
                  cursor: messages.length ? 'pointer' : 'default',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: UI_FONT,
                  fontSize: 11,
                  fontWeight: 750,
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 9,
                }}
              >
                <ArrowBendUpRight size={14} />
                Orchestrator
              </button>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || sending}
                style={{
                  minHeight: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: !input.trim() || sending ? 'var(--t-divider-subtle)' : 'var(--t-accent)',
                  color: !input.trim() || sending ? 'var(--t-text-faint)' : 'var(--t-on-accent, #ffffff)',
                  cursor: !input.trim() || sending ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: UI_FONT,
                  fontSize: 11,
                  fontWeight: 800,
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 10,
                }}
              >
                {sending ? 'Sending' : 'Send'}
                <PaperPlaneTilt size={14} weight="fill" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const actionButtonBaseStyle: CSSProperties = {
  width: 'auto',
  height: 28,
  borderRadius: 9,
  border: '1px solid var(--o8-scratch-input-border)',
  background: 'var(--o8-scratch-input)',
  color: 'var(--o8-scratch-action)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  lineHeight: '14px',
  paddingTop: 0,
  paddingRight: 9,
  paddingBottom: 0,
  paddingLeft: 8,
  fontFamily: UI_FONT,
  fontSize: 11,
  fontWeight: 750,
  flexShrink: 0,
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.24)',
};

const iconButtonStyle: CSSProperties = {
  ...actionButtonBaseStyle,
  width: 30,
  minWidth: 30,
  paddingRight: 0,
  paddingLeft: 0,
};

const textButtonStyle: CSSProperties = {
  ...actionButtonBaseStyle,
  minWidth: 72,
};
