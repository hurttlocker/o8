'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUp, Brain, ChevronDown, MessageSquare, Trash2 } from '../lucide-shims';
import { useTheme } from '@/lib/theme/context';
import { getPalette, resolveTheme } from '@/lib/theme/registry';
import { MarkdownRender, proseWithoutBrainCitationMarkers } from '../o8-panel/markdown-render';
import { usePrBrainChat } from './usePrBrainChat';
import type { PrComposerMode, PrDetail, PrReviewAction } from './types';
import { matchingPrCommands, PrComposerCommands } from './PrComposerCommands';
import { PrCommentComposer } from './PrCommentComposer';
import { AnticipationRing } from '@/app/preview/canvas-glass/anticipation-ring';

export function prBrainContext(detail: PrDetail, repoSlug?: string | null): string {
  return JSON.stringify({
    repo: detail.resolvedRepo || repoSlug || null, number: detail.number, url: detail.url,
    title: detail.title, state: detail.state, author: detail.author,
    head: { branch: detail.headRefName, sha: detail.headSha }, base: { branch: detail.baseRefName, sha: detail.baseSha },
    updatedAt: detail.updatedAt, description: detail.body.slice(0, 6000), descriptionTruncated: detail.body.length > 6000,
    totals: { files: detail.changedFiles, additions: detail.additions, deletions: detail.deletions },
    // A bounded inventory is honest about coverage; patches are not sent automatically.
    files: detail.files.slice(0, 40).map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    filesListed: Math.min(detail.files.length, 40), patchesIncluded: false,
    checks: detail.statusCheckRollup.slice(0, 25),
  });
}

export function PrBrainComposer({ detail, repoSlug, repoPath, draft, onDraftChange, mode = 'brain', onModeChange, commentDraft = '', onCommentDraftChange, reviewDraft = '', onReviewDraftChange, reviewAction = 'review-comment', onReviewActionChange, reviewHeadSha, onReviewHeadChange, onCommentPosted }: {
  detail: PrDetail; repoSlug?: string | null; repoPath?: string | null; draft: string; onDraftChange: (draft: string) => void;
  reviewDraft?: string; onReviewDraftChange?: (draft: string) => void; reviewAction?: PrReviewAction; onReviewActionChange?: (action: PrReviewAction) => void; reviewHeadSha?: string; onReviewHeadChange?: () => void;
  mode?: PrComposerMode; onModeChange?: (mode: PrComposerMode, commandDraft?: string) => void; commentDraft?: string; onCommentDraftChange?: (draft: string) => void; onCommentPosted?: () => void;
}) {
  const commandId = useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const matches = matchingPrCommands(draft);
  const showCommands = mode === 'brain' && matches !== null && !commandDismissed && Boolean(onModeChange);
  const selectedCommand = Math.min(commandIndex, Math.max(0, (matches?.length || 0) - 1));
  const chooseCommand = (next: PrComposerMode) => { setCommandDismissed(true); onModeChange?.(next, ''); };
  const input = useRef<HTMLTextAreaElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const [composerHeight, setComposerHeight] = useState(48);
  const [inputFocused, setInputFocused] = useState(false);
  const context = useMemo(() => prBrainContext(detail, repoSlug), [detail, repoSlug]);
  const chat = usePrBrainChat(`${repoSlug || detail.resolvedRepo || ''}:${detail.number}:${repoPath || ''}`, repoPath, context);
  const { workspaceGlass, paletteId } = useTheme();
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const panel = surface?.closest<HTMLElement>('[data-pr-detail]');
    if (!surface || !panel) return;
    // Native vibrancy blurs the desktop, but may not blur sibling DOM content.
    // Fade the reading surface beneath this floating sheet without moving its scroll position.
    const measure = () => panel.style.setProperty('--pr-composer-occlusion', `${surface.getBoundingClientRect().height + 12}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => { observer.disconnect(); panel.style.removeProperty('--pr-composer-occlusion'); };
  }, []);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    const height = Math.min(96, input.current.scrollHeight);
    input.current.style.height = `${height}px`;
    setComposerHeight(Math.max(48, height + 16));
  }, [draft, mode]);
  useEffect(() => {
    const scroller = transcript.current;
    if (scroller && followBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [chat.messages, chat.expanded]);
  const collapse = () => { onModeChange?.('brain'); chat.collapse(); window.requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); };
  const expanded = mode !== 'brain' || chat.expanded;
  const canSend = Boolean(draft.trim() && repoPath && !chat.busy && !showCommands);
  const opaqueTokens = resolveTheme(getPalette(paletteId), 'solid').cssVars;
  const surfaceTokens: CSSProperties = workspaceGlass ? {} : opaqueTokens as CSSProperties;
  const surface = workspaceGlass ? 'var(--t-glass-elevated)' : opaqueTokens['--t-popover-surface'];
  return <section ref={surfaceRef} data-pr-brain-chat data-expanded={expanded} aria-label={`${mode === 'brain' ? 'Brain conversation' : 'GitHub ' + mode} about PR #${detail.number}`} onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented && expanded) { event.preventDefault(); event.stopPropagation(); collapse(); } }} style={{ ...surfaceTokens, color: 'var(--t-text)', position: 'absolute', left: 14, right: 14, bottom: 12, zIndex: 5, display: 'flex', flexDirection: 'column', height: expanded ? `min(${mode === 'review' ? 340 : mode === 'comment' ? 270 : 380}px, calc(100% - 70px))` : composerHeight + (showCommands ? (matches!.length ? 46 + matches!.length * 45 : 66) : 0), minHeight: 48, maxHeight: 'calc(100% - 70px)', border: '1px solid var(--t-border)', borderRadius: expanded || showCommands ? 18 : 26, background: surface, backdropFilter: workspaceGlass ? 'blur(22px) saturate(1.2)' : 'none', WebkitBackdropFilter: workspaceGlass ? 'blur(22px) saturate(1.2)' : 'none', boxShadow: 'var(--t-panel-shadow)', overflow: 'visible', isolation: 'isolate', transition: showCommands ? 'none' : 'height 180ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 180ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
    {mode !== 'brain' && onCommentDraftChange ? <PrCommentComposer detail={detail} repoSlug={repoSlug} mode={mode} onModeChange={onModeChange} draft={mode === 'review' ? reviewDraft : commentDraft} onDraftChange={mode === 'review' ? onReviewDraftChange || (() => {}) : onCommentDraftChange} reviewAction={reviewAction} onReviewActionChange={onReviewActionChange} reviewHeadSha={reviewHeadSha} onReviewHeadChange={onReviewHeadChange} onBrain={() => { onModeChange?.('brain'); chat.expand(); }} onCollapse={collapse} onPosted={onCommentPosted} /> : <>
    {chat.expanded ? <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, flexShrink: 0, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 14, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        <Brain size={14} aria-hidden="true" /><span style={{ fontSize: 12, fontWeight: 500 }}>Brain <span style={{ color: 'var(--t-text-muted)', fontWeight: 400 }}>· PR #{detail.number}</span></span><span style={{ flex: 1 }} />
        {onModeChange ? <button type="button" aria-label="Write a GitHub comment" title="Write a GitHub comment (or type /comment)" onClick={() => onModeChange('comment')} style={{ ...iconStyle, width: 'auto', gap: 5, fontSize: 11, fontFamily: 'inherit' }}><MessageSquare size={13} aria-hidden="true" />Comment</button> : null}
        <button type="button" aria-label="Clear PR conversation" disabled={!chat.messages.length || chat.busy} onClick={chat.clear} style={{ ...iconStyle, opacity: chat.busy || !chat.messages.length ? 0.4 : 1 }}><Trash2 size={13} aria-hidden="true" /></button>
        <button type="button" aria-label="Collapse PR conversation" onClick={collapse} style={iconStyle}><ChevronDown size={15} aria-hidden="true" /></button>
      </header>
      <div ref={transcript} role="log" aria-label={`Brain answers about PR #${detail.number}`} aria-live="polite" onScroll={(event) => { const node = event.currentTarget; followBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 40; }} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, fontSize: 12, lineHeight: 1.6 }}>
        {!chat.messages.length ? <p style={{ margin: 0, color: 'var(--t-text-muted)' }}>Ask a question while keeping this pull request in view.</p> : null}
        {chat.messages.map((message) => <div key={message.id} style={{ display: 'flex', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
          <div style={{ maxWidth: message.role === 'user' ? '90%' : '100%', minWidth: 0, borderRadius: 12, paddingTop: 8, paddingRight: 11, paddingBottom: 8, paddingLeft: 11, background: message.role === 'user' ? 'var(--t-accent-soft)' : 'var(--t-hover)', color: 'var(--t-text)', overflowWrap: 'anywhere' }}>
            {message.role === 'user' ? <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span> : message.text ? <MarkdownRender content={proseWithoutBrainCitationMarkers(message.text)} /> : <span role="status" style={{ color: 'var(--t-text-muted)' }}>{message.reading ? `Reading ${message.reading} sources…` : 'Searching the Brain…'}</span>}
            {message.sources?.length ? <details style={{ marginTop: 6, fontSize: 11, color: 'var(--t-text-muted)' }}><summary style={{ cursor: 'pointer' }}>Sources · {message.sources.length}</summary>{message.sources.map((source, index) => <div key={`${source.rowId || ''}:${index}`} style={{ marginTop: 6 }}>{source.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--t-accent)' }}>{source.title || 'Source'}</a> : <span>{source.title || 'Source'}</span>}{source.excerpt ? <p style={{ marginTop: 4, marginBottom: 0 }}>{source.excerpt}</p> : null}</div>)}</details> : null}
          </div>
        </div>)}
        {chat.error ? <div role="alert" style={{ color: 'var(--t-danger)', fontSize: 11 }}>{chat.error}</div> : null}
      </div>
    </> : null}
    {showCommands ? <PrComposerCommands id={commandId} matches={matches!} selected={selectedCommand} onSelect={chooseCommand} /> : null}
    <form aria-label={`Ask Brain about PR #${detail.number}`} onFocusCapture={() => setInputFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInputFocused(false); }} onSubmit={(event) => { event.preventDefault(); if (!canSend) return; followBottom.current = true; void chat.ask(draft); onDraftChange(''); }} style={{ position: 'relative', ['--cnv-ink' as string]: 'var(--t-accent-border)', display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, minHeight: 48, flexShrink: 0, borderTop: chat.expanded ? '1px solid var(--t-divider-subtle)' : undefined, paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 14 }}>
      <AnticipationRing focused={inputFocused} radius={chat.expanded ? 18 : 26} />
      <textarea ref={input} rows={1} data-pr-question={detail.number} aria-label={`Question about PR #${detail.number}`} placeholder={repoPath ? 'Ask about this PR, or /comment · /review' : 'Connect a local repository to ask Brain'} value={draft} disabled={!repoPath} aria-autocomplete="list" aria-controls={showCommands ? commandId : undefined} aria-expanded={showCommands} aria-haspopup="listbox" aria-activedescendant={showCommands && matches![selectedCommand] ? `${commandId}-${matches![selectedCommand].id}` : undefined} role="combobox" onBlur={() => setCommandDismissed(true)} onChange={(event) => {
        const text = event.target.value;
        const command = text.match(/^\/(comment|review)\s+([\s\S]*)$/i);
        setCommandDismissed(false); setCommandIndex(0);
        if (command && onModeChange) onModeChange(command[1].toLowerCase() as PrComposerMode, command[2] || ''); else onDraftChange(text);
      }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (showCommands && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') setCommandDismissed(true);
          else if (event.key === 'Enter') { if (matches![selectedCommand]) chooseCommand(matches![selectedCommand].mode); }
          else if (matches!.length) setCommandIndex((selectedCommand + (event.key === 'ArrowDown' ? 1 : -1) + matches!.length) % matches!.length);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} style={{ flex: 1, minWidth: 0, maxHeight: 96, resize: 'none', overflowY: 'auto', border: 0, padding: 0, background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12, lineHeight: '20px', scrollbarWidth: 'none' }} />
      {!chat.expanded ? <button type="button" aria-label={`Open Brain conversation for PR #${detail.number}`} onClick={() => { chat.expand(); input.current?.focus({ preventScroll: true }); }} style={{ ...iconStyle, width: 'auto', gap: 5, fontSize: 11, fontFamily: 'inherit' }}><Brain size={15} aria-hidden="true" />Brain</button> : null}
      <button type="submit" aria-label={`Ask Brain about PR #${detail.number}`} disabled={!canSend} style={{ width: 32, height: 32, padding: 0, boxSizing: 'border-box', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: canSend ? '1px solid var(--t-accent-border)' : '1px solid var(--t-border)', background: canSend ? 'var(--t-accent)' : 'var(--t-hover)', color: canSend ? 'var(--t-success-contrast, #fff)' : 'var(--t-text-faint)', opacity: canSend ? 1 : 0.6, cursor: canSend ? 'pointer' : 'default' }}><ArrowUp size={16} strokeWidth={2} aria-hidden="true" /></button>
    </form>
    </>}
  </section>;
}
const iconStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flexShrink: 0, border: 0, padding: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' };
