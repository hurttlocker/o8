'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowBendUpRight,
  ArrowsInSimple,
  ArrowsOutSimple,
  Article,
  Brain,
  PaperPlaneTilt,
  Trash,
  X,
} from '@phosphor-icons/react';
import { MarkdownRender } from '../markdown-render';
import { useOrchestratorData } from '../../orchestrator-data-context';

const UI_FONT = 'var(--font-sans-system)';
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
type ScratchTriggerPlacement = 'floating' | 'review-toolbar';

interface ScratchCitation {
  kind: string;
  rowId: string;
  table?: string;
  excerpt?: string;
  url?: string;
}

interface ScratchMessage {
  id: string;
  role: ScratchRole;
  content: string;
  /** Engineering Brain citations rendered as small pills below the answer. */
  citations?: ScratchCitation[];
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
  if (!repoPath) {
    return { surface, selection };
  }

  // No file selected → fall back to a workspace-wide change digest so the
  // cheap model isn't flying blind. Pulls the same snapshot ReviewPanel
  // renders (branch, ahead/behind, diffstat, changed-file list, recent
  // commits). Tools available in the scratch-chat API let the model drill
  // into individual file diffs if it needs the actual hunks.
  if (!selectedFile) {
    try {
      const params = new URLSearchParams({ workspace: repoPath });
      const response = await fetch(`/api/review/workspace?${params.toString()}`);
      const snap = await response.json().catch(() => ({})) as {
        branch?: string;
        ahead?: number;
        behind?: number;
        dirty?: boolean;
        diffStat?: string;
        changedFiles?: Array<{ path?: string; status?: string; additions?: number; deletions?: number }>;
        recentCommits?: string[];
        error?: string;
      };
      if (snap.error) {
        return { repoPath, surface, selection, content: `Workspace snapshot unavailable: ${snap.error}` };
      }
      const fileSummary = (snap.changedFiles ?? [])
        .slice(0, 60)
        .map((f) => {
          const stat = f.additions !== undefined && f.deletions !== undefined
            ? ` +${f.additions} -${f.deletions}`
            : '';
          return `  ${f.status ?? '?'} ${f.path ?? '?'}${stat}`;
        })
        .join('\n');
      const commits = (snap.recentCommits ?? []).slice(0, 8).join('\n');
      const lines = [
        `Branch: ${snap.branch ?? '(unknown)'}`,
        `Ahead/behind: ${snap.ahead ?? 0} / ${snap.behind ?? 0}${snap.dirty ? ' · dirty' : ''}`,
        '',
        `Diffstat:\n${snap.diffStat || '(no changes)'}`,
        '',
        fileSummary ? `Changed files (${snap.changedFiles?.length ?? 0}):\n${fileSummary}` : 'No changed files.',
        commits ? `\nRecent commits:\n${commits}` : '',
      ].filter(Boolean).join('\n');
      return { repoPath, surface, selection, content: lines };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Workspace snapshot fetch failed.';
      return { repoPath, surface, selection, content: reason };
    }
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
  placement?: ScratchTriggerPlacement;
}) {
  // Flat per DESIGN.md §06.7 — same language as HeaderIconPill regardless of
  // placement. The chunky ring + inset shadow that used to differentiate the
  // floating placement was the "wrong hover" the operator called out.
  return (
    <button
      type="button"
      title={disabled ? 'Select a repo to ask o8' : 'Ask o8 (Cmd+E)'}
      aria-label="Ask o8"
      aria-disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      style={{
        width: 26,
        height: 26,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
        border: 'none',
        borderRadius: 7,
        background: active ? 'var(--t-input-bg)' : 'transparent',
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
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(event) => {
        if (!active && !disabled) {
          event.currentTarget.style.background = 'var(--t-hover)';
        }
      }}
      onMouseLeave={(event) => {
        if (!active) {
          event.currentTarget.style.background = 'transparent';
        }
      }}
    >
      <AskO8Icon size={14} color={active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE} />
    </button>
  );
}

export function O8ScratchChat({
  repoPath,
  selectedFile,
  surface,
  placement = 'floating',
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  surface: ScratchSurface;
  placement?: ScratchTriggerPlacement;
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
  const [askLoading, setAskLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [selectionSnapshot, setSelectionSnapshot] = useState('');
  const [panelPosition, setPanelPosition] = useState({ top: 0, right: 12 });
  // Re-mounted post-#1089 — operator restored after ReviewPanel rework dropped
  // the original mount. Repo presence is the only hard requirement; the chat
  // operates against general repo context when no file is selected (file/diff
  // hydration in readPanelContext already short-circuits on null selectedFile).
  const disabled = !repoPath;

  const scopeLabel = useMemo(() => {
    if (selectedFile) return compactPath(selectedFile);
    if (repoPath) return 'All changes';
    return 'No repo';
  }, [repoPath, selectedFile]);

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
    setAskLoading(false);
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

  const askBrain = useCallback(async () => {
    // #1117 — third composer path: send the current input to the Engineering
    // Brain via the non-streaming /api/cortex/ask/answer endpoint, render the
    // JSON answer in an assistant bubble with citation pills underneath.
    const question = input.trim();
    if (!question || askLoading) return;

    const userMessage: ScratchMessage = {
      id: `o8-ask-brain-user-${Date.now()}`,
      role: 'user',
      content: question,
    };
    const assistantId = `o8-ask-brain-assistant-${Date.now() + 1}`;
    const assistantMessage: ScratchMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput('');
    setError(null);
    setHandoffNote(null);
    setAskLoading(true);

    // Classifier currently runs 11-43s end-to-end; cap at 90s so a hung
    // backend doesn't leave the bubble in a silent Thinking… state.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);

    try {
      const response = await fetch('/api/cortex/ask/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, repoPath: repoPath ?? undefined }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        answer?: string;
        citations?: ScratchCitation[];
        error?: string;
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Ask Brain failed (${response.status}).`);
      }
      const answer = payload.answer?.trim() || 'The Engineering Brain returned no answer.';
      const citations = Array.isArray(payload.citations) ? payload.citations : [];
      setMessages((current) => current.map((message) => (
        message.id === assistantId
          ? { ...message, content: answer, citations }
          : message
      )));
    } catch (err) {
      const reason = (err as { name?: string })?.name === 'AbortError'
        ? 'Ask Brain timed out after 90s.'
        : err instanceof Error ? err.message : 'Ask Brain failed.';
      setMessages((current) => current.filter((message) => message.id !== assistantId));
      setError(reason);
    } finally {
      clearTimeout(timeoutId);
      setAskLoading(false);
    }
  }, [askLoading, input, repoPath]);

  return (
    <>
      <div ref={buttonRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <HeaderButton active={open} disabled={disabled && !open} onOpen={togglePanel} placement={placement} />
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

          <div ref={scrollRef} className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: expanded ? 300 : 170, maxHeight: expanded ? 560 : 380, overflow: 'auto', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
            {messages.length === 0 ? (
              <div style={{ borderRadius: 14, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, color: 'var(--t-text-muted)', fontSize: 12, lineHeight: '18px' }}>
                {selectedFile
                  ? 'Ask about the current file or diff. This is read-only; edits go through the orchestrator.'
                  : 'Ask about the workspace changes (branch, diffstat, recent commits). This is read-only; edits go through the orchestrator.'}
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
                      message.content ? (
                        <>
                          <MarkdownRender content={message.content} />
                          {message.citations && message.citations.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                              {message.citations.map((citation, idx) => (
                                <span
                                  key={`${message.id}-cite-${idx}`}
                                  title={citation.excerpt || `${citation.kind}:${citation.rowId}`}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    height: 18,
                                    borderRadius: 6,
                                    paddingTop: 0,
                                    paddingRight: 6,
                                    paddingBottom: 0,
                                    paddingLeft: 6,
                                    background: 'var(--t-divider-subtle)',
                                    color: 'var(--t-text-muted)',
                                    fontFamily: MONO_FONT,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    letterSpacing: '-0.01em',
                                    cursor: citation.url ? 'pointer' : 'default',
                                  }}
                                  onClick={() => {
                                    if (citation.url) window.open(citation.url, '_blank', 'noopener,noreferrer');
                                  }}
                                >
                                  {citation.kind}:{citation.rowId}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : <span style={{ color: 'var(--t-text-muted)' }}>Thinking...</span>
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
              placeholder={selectedFile ? 'Ask about this file or diff...' : 'Ask about the workspace changes...'}
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
                  minHeight: 26,
                  borderRadius: 7,
                  border: 'none',
                  background: 'transparent',
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
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(e) => { if (repoPath && !summaryLoading) { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = repoPath && !summaryLoading ? 'var(--t-text-muted)' : 'var(--t-text-faint)'; }}
              >
                <Article size={14} />
                {summaryLoading ? 'Summarizing' : 'Summary'}
              </button>
              <button
                type="button"
                onClick={addToOrchestrator}
                disabled={!messages.length || !data?.onAcceptDirectiveProposal}
                style={{
                  minHeight: 26,
                  borderRadius: 7,
                  border: 'none',
                  background: 'transparent',
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
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(e) => { if (messages.length) { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = messages.length ? 'var(--t-text-muted)' : 'var(--t-text-faint)'; }}
              >
                <ArrowBendUpRight size={14} />
                Orchestrator
              </button>
              <button
                type="button"
                onClick={() => { void askBrain(); }}
                disabled={!input.trim() || askLoading}
                title={!input.trim() ? 'Type a question to ask the Engineering Brain' : 'Ask the Engineering Brain (cortex_ask)'}
                style={{
                  minHeight: 26,
                  borderRadius: 7,
                  border: 'none',
                  background: 'transparent',
                  color: input.trim() && !askLoading ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
                  cursor: input.trim() && !askLoading ? 'pointer' : 'default',
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
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(e) => { if (input.trim() && !askLoading) { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = input.trim() && !askLoading ? 'var(--t-text-muted)' : 'var(--t-text-faint)'; }}
              >
                <Brain size={14} />
                {askLoading ? 'Asking' : 'Ask Brain'}
              </button>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || sending}
                style={{
                  // Primary CTA — keeps the accent fill since it's the
                  // composer's primary action. Geometry matched to the
                  // flat pill spec (26h, 7r). No inset shadow.
                  minHeight: 26,
                  borderRadius: 7,
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
  // Flat per DESIGN.md §06.7 — transparent at rest, var(--t-hover) on hover
  // (handled per-call-site since this is just a base). No border, no inset
  // shadow, height 26 / radius 7.
  width: 'auto',
  height: 26,
  borderRadius: 7,
  border: 'none',
  background: 'transparent',
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
};

const iconButtonStyle: CSSProperties = {
  ...actionButtonBaseStyle,
  width: 26,
  minWidth: 26,
  paddingRight: 0,
  paddingLeft: 0,
};

const textButtonStyle: CSSProperties = {
  ...actionButtonBaseStyle,
  minWidth: 72,
};
