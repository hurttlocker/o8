'use client';

import { FloatingSurface, useFloatingSurfaceMaterial } from '../../FloatingSurface';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
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
import { CircleSpark } from 'iconoir-react';
import { MarkdownRender, proseWithoutBrainCitationMarkers } from '../markdown-render';
import { useOrchestratorData } from '../../orchestrator-data-context';
import { track } from '@/lib/analytics/track';
import { readPanelContext, type ScratchSurface } from './scratch-panel-context';
import { useScratchDialog } from './useScratchDialog';
import { scratchSurfaceTokens } from './o8-scratch-surface';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const O8_ICON_ACTIVE = 'var(--t-text)';
const O8_ICON_INACTIVE = 'var(--t-text-muted)';

type ScratchRole = 'user' | 'assistant';
type ScratchTriggerPlacement = 'floating' | 'review-toolbar';

interface ScratchCitation {
  kind: string;
  rowId: string;
  table?: string;
  /** Human-readable source title (directive title, PR title, …) — the
   *  2026-06-11 parity contract. Pills render this over kind:rowId. */
  title?: string;
  excerpt?: string;
  url?: string;
}

/** Early retrieval summary from the SSE `sources` event — what the Brain is
 *  reading, surfaced live while the model is still composing. */
interface ScratchSources {
  count: number;
  top: Array<{ kind: string; title: string }>;
  /** 'referee' when the judgment referee classified the question (#2436). */
  classifier?: string;
}

interface ScratchMessage {
  id: string;
  role: ScratchRole;
  content: string;
  /** Engineering Brain citations rendered as small pills below the answer. */
  citations?: ScratchCitation[];
  /** Retrieval summary — drives the live "Reading N sources…" phase line and
   *  the "cited X of N" caption after the answer lands. */
  sources?: ScratchSources;
}

type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

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
  // Iconoir CircleSpark — operator-locked for the Ask-o8 chat trigger
  // across every O8 panel surface. Circle + spark reads as "spark a
  // question to o8" cleanly.
  return (
    <CircleSpark
      width={size}
      height={size}
      color={color}
      strokeWidth={2}
      style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}
    />
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

function HeaderButton({
  active,
  disabled,
  onOpen,
  surfaceLabel,
}: {
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
  placement?: ScratchTriggerPlacement;
  surfaceLabel?: string;
}) {
  // Flat per DESIGN.md §06.7 — same language as HeaderIconPill regardless of
  // placement. The chunky ring + inset shadow that used to differentiate the
  // floating placement was the "wrong hover" the operator called out.
  return (
    <button
      type="button"
      title={disabled ? 'Select a repo to ask o8' : 'Ask o8 (Cmd+E)'}
      aria-label={surfaceLabel ? `Ask o8 — ${surfaceLabel}` : 'Ask o8'}
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
  surfaceLabel,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  surface: ScratchSurface;
  placement?: ScratchTriggerPlacement;
  surfaceLabel?: string;
}) {
  const data = useOrchestratorData();
  const buttonRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const material = useFloatingSurfaceMaterial();

  const [open, setOpen] = useState(false);
  const closePanel = useCallback(() => setOpen(false), []);
  useScratchDialog(open, dialogRef, buttonRef, closePanel);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ScratchMessage[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [askLoading, setAskLoading] = useState(false);
  /** `${messageId}-${idx}` of the source pill expanded into its detail view. */
  const [expandedCite, setExpandedCite] = useState<string | null>(null);
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
    if (repoPath) return surfaceLabel || 'All changes';
    return 'No repo';
  }, [repoPath, selectedFile, surfaceLabel]);

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
      // ⌘E toggles the Brain — but NOT ⌘⇧E, which is the global report-issue
      // hotkey (ReportIssueHost). Without this Shift guard both fired at once.
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'e') return;
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

  useEffect(() => () => { abortRef.current?.abort(); }, []);

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
    if (!question || sending || askLoading || abortRef.current) return;

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
  }, [input, messages, repoPath, selectedFile, selectionSnapshot, sending, askLoading, surface]);

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
    // Brain. Streams the SSE /api/cortex/ask route (2026-06-11 brain perf
    // pass) so Class B answers paint as Sonnet generates instead of arriving
    // as one blob after the full pipeline; citation pills land underneath.
    const question = input.trim();
    if (!question || askLoading || abortRef.current) return;

    track('brain.asked'); // coarse usage signal (analytics epic #1249) — no content

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

    // Whole-ask ceiling so a hung backend doesn't leave the bubble in a
    // silent Thinking… state. Streaming usually paints well before this.
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 90_000);

    try {
      const response = await fetch('/api/cortex/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, repoPath: repoPath ?? undefined }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Ask Brain failed (${response.status}).`);
      }

      let answer = '';
      const citations: ScratchCitation[] = [];
      let streamError: string | null = null;

      const applyFrame = (eventName: string, dataLine: string) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(dataLine) as Record<string, unknown>;
        } catch {
          return;
        }
        if (eventName === 'token' && typeof payload.text === 'string') {
          answer += payload.text;
          setMessages((current) => current.map((message) => (
            message.id === assistantId ? { ...message, content: answer } : message
          )));
        } else if (eventName === 'sources') {
          // Retrieval finished — show what the Brain is reading while the
          // model composes.
          const sources: ScratchSources = {
            count: typeof payload.count === 'number' ? payload.count : 0,
            top: Array.isArray(payload.top) ? (payload.top as ScratchSources['top']) : [],
            ...(typeof payload.classifier === 'string' ? { classifier: payload.classifier } : {}),
          };
          setMessages((current) => current.map((message) => (
            message.id === assistantId ? { ...message, sources } : message
          )));
        } else if (eventName === 'citation') {
          citations.push(payload as unknown as ScratchCitation);
        } else if (eventName === 'error' && typeof payload.message === 'string') {
          streamError = payload.message;
        } else if (eventName === 'alert' && typeof payload.message === 'string') setHandoffNote(payload.message);
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let eventName = 'message';
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLine += line.slice(6);
          }
          if (dataLine) applyFrame(eventName, dataLine);
          sep = buffer.indexOf('\n\n');
        }
        if (done) break;
      }

      if (streamError) throw new Error(streamError);
      const finalAnswer = answer.trim() || 'The Engineering Brain returned no answer.';
      setMessages((current) => current.map((message) => (
        message.id === assistantId
          ? { ...message, content: finalAnswer, citations }
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
      if (abortRef.current === controller) abortRef.current = null;
      setAskLoading(false);
    }
  }, [askLoading, input, repoPath]);

  return (
    <>
      <div ref={buttonRef} style={{ display: 'inline-flex', flexShrink: 0, width: undefined }}>
        <HeaderButton active={open} disabled={disabled && !open} onOpen={togglePanel} placement={placement} surfaceLabel={surfaceLabel} />
      </div>
      {/* Portal escapes transformed ancestors so viewport coordinates are real. */}
      {open ? createPortal(
        <FloatingSurface
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={surfaceLabel ? `Ask o8 — ${surfaceLabel}` : 'Ask o8'}
          contentStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: expanded ? 'min(780px, calc(100vh - 72px))' : 'min(590px, calc(100vh - 96px))', overflow: 'hidden' }}
          style={{
            ...scratchSurfaceTokens(material.isGlass),
            position: 'fixed',
            top: panelPosition.top,
            right: panelPosition.right,
            width: expanded ? 'min(760px, calc(100vw - 32px))' : 'min(420px, calc(100vw - 24px))',
            maxHeight: expanded ? 'min(780px, calc(100vh - 72px))' : 'min(590px, calc(100vh - 96px))',
            color: 'var(--o8-scratch-text)',
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
              <div style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 350, letterSpacing: '-0.1px', lineHeight: 1.25 }}>Ask o8</div>
              <div style={{ color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
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
              <div style={{ borderRadius: 14, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, color: 'var(--t-text-faint)', fontSize: 13, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45 }}>
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
                      fontSize: 13,
                      fontWeight: 300,
                      letterSpacing: '-0.1px',
                      lineHeight: 1.45,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {message.role === 'assistant' ? (
                      message.content ? (
                        <>
                          <MarkdownRender content={proseWithoutBrainCitationMarkers(message.content)} />
                          {message.citations && message.citations.length > 0 ? (
                            <>
                              {message.sources ? (
                                <div style={{ marginTop: 8, fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>
                                  {message.citations.length} cited · {message.sources.count} sources considered{message.sources.classifier ? ` · classified by ${message.sources.classifier}` : ''}
                                </div>
                              ) : null}
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: message.sources ? 4 : 8 }}>
                                {message.citations.map((citation, idx) => {
                                  const citeKey = `${message.id}-${idx}`;
                                  const label = citation.title || `${citation.kind}:${citation.rowId}`;
                                  return (
                                    <span
                                      key={`${message.id}-cite-${idx}`}
                                      title={label}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        height: 18,
                                        maxWidth: 220,
                                        borderRadius: 6,
                                        paddingTop: 0,
                                        paddingRight: 6,
                                        paddingBottom: 0,
                                        paddingLeft: 6,
                                        background: expandedCite === citeKey ? 'var(--t-hover)' : 'var(--t-divider-subtle)',
                                        color: 'var(--t-text-muted)',
                                        fontSize: 10,
                                        fontWeight: 300,
                                        letterSpacing: '-0.1px',
                                        cursor: 'pointer',
                                      }}
                                      onClick={() => {
                                        setExpandedCite((current) => (current === citeKey ? null : citeKey));
                                      }}
                                    >
                                      <span style={{ fontFamily: MONO_FONT, fontSize: 8.5, textTransform: 'uppercase', color: 'var(--t-text-faint)', flexShrink: 0 }}>
                                        {citation.kind}
                                      </span>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                                    </span>
                                  );
                                })}
                              </div>
                              {message.citations.map((citation, idx) => {
                                const citeKey = `${message.id}-${idx}`;
                                if (expandedCite !== citeKey) return null;
                                const cleanExcerpt = (citation.excerpt ?? '').replace(/[«»]/g, '');
                                return (
                                  <div
                                    key={`${message.id}-cite-detail-${idx}`}
                                    style={{
                                      marginTop: 6,
                                      borderRadius: 10,
                                      border: '1px solid var(--t-divider-subtle)',
                                      background: 'var(--t-bg-card)',
                                      paddingTop: 8,
                                      paddingRight: 10,
                                      paddingBottom: 8,
                                      paddingLeft: 10,
                                    }}
                                  >
                                    <div style={{ fontSize: 11.5, fontWeight: 420, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
                                      {citation.title || `${citation.kind}:${citation.rowId}`}
                                    </div>
                                    <div style={{ marginTop: 2, fontFamily: MONO_FONT, fontSize: 9, color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
                                      {citation.kind} · {citation.rowId}
                                    </div>
                                    {cleanExcerpt ? (
                                      <div style={{ marginTop: 5, fontSize: 11.5, fontWeight: 300, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                                        {cleanExcerpt}
                                      </div>
                                    ) : null}
                                    {citation.url ? (
                                      <button
                                        type="button"
                                        onClick={() => { window.open(citation.url, '_blank', 'noopener,noreferrer'); }}
                                        style={{
                                          marginTop: 6,
                                          border: 'none',
                                          background: 'transparent',
                                          color: 'var(--t-accent)',
                                          fontFamily: UI_FONT,
                                          fontSize: 10.5,
                                          fontWeight: 350,
                                          letterSpacing: '-0.1px',
                                          cursor: 'pointer',
                                          paddingTop: 0,
                                          paddingRight: 0,
                                          paddingBottom: 0,
                                          paddingLeft: 0,
                                        }}
                                      >
                                        Open source ↗
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </>
                          ) : null}
                        </>
                      ) : (
                        <span style={{ color: 'var(--t-text-muted)' }}>
                          {message.sources
                            ? `Reading ${message.sources.count} sources…${message.sources.top.length > 0 ? ` ${message.sources.top.slice(0, 2).map((s) => s.title).join(' · ')}` : ''}`
                            : message.id.startsWith('o8-ask-brain-assistant')
                              ? 'Searching the brain…'
                              : 'Thinking...'}
                        </span>
                      )
                    ) : (
                      message.content
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {error || handoffNote ? (
            <div role="alert" style={{ borderTop: '1px solid var(--t-divider-subtle)', color: error ? 'var(--t-brand-red)' : 'var(--t-terminal-ansi-bright-green, #16a34a)', fontSize: 11, fontWeight: 350, letterSpacing: '-0.1px', paddingTop: 8, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }}>
              {error ?? handoffNote}
            </div>
          ) : null}

          <div style={{ borderTop: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
            <textarea
              ref={inputRef}
              data-o8-scratch-input="true"
              aria-label={surfaceLabel ? `Follow-up about ${surfaceLabel}` : 'Question for o8'}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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
                fontSize: 13,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                lineHeight: 1.45,
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
                  fontWeight: 350,
                  letterSpacing: '-0.1px',
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
                  fontWeight: 350,
                  letterSpacing: '-0.1px',
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
                title={
                  !input.trim()
                    ? 'Type a question to ask the Engineering Brain'
                    : 'Ask the Engineering Brain (cortex_ask) — paid path: grok-4.1-fast classifier + retrieval (o8 sub) + Claude Sonnet 5 via your Claude Code subscription'
                }
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
                  fontWeight: 350,
                  letterSpacing: '-0.1px',
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 9,
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  position: 'relative',
                }}
                onMouseEnter={(e) => { if (input.trim() && !askLoading) { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = input.trim() && !askLoading ? 'var(--t-text-muted)' : 'var(--t-text-faint)'; }}
              >
                {/* Brand-orange premium dot — the cost-asymmetry signal. Free
                    buttons (Send / Summary / Orchestrator) don't carry one;
                    Ask Brain rides a paid pipeline so the dot flags it. */}
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: 'var(--t-brand-orange, #FF5A1F)',
                    flexShrink: 0,
                    boxShadow: '0 0 0 1.5px var(--o8-scratch-surface)',
                  }}
                />
                <Brain size={14} />
                {askLoading ? 'Asking' : 'Ask Brain'}
              </button>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || sending || askLoading}
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
        </FloatingSurface>,
        document.body,
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
  fontWeight: 350,
  letterSpacing: '-0.1px',
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
