'use client';

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MaintainerReplyContext } from '@/lib/inbox/maintainer-draft';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { readOrchestratorRuntimePreference, subscribeOrchestratorRuntimePreference } from '@/lib/orchestrator/preferences';
import { OrchestratorContextResidencyProvider } from '../orchestrator/context-residency';
import { useOrchestratorData } from '../orchestrator-data-context';
import type { ThoughtsChatPanelChromeState, ThoughtsChatPanelHandle } from '../thoughts/ThoughtsChatPanel';
import { buildAgentTargets } from '../thoughts/utils';
import { FloatingSurface } from '../FloatingSurface';
import { ExternalLink, X } from '../lucide-shims';
import { REPLY_MODEL_DEFAULTS } from '../thoughts/chat-panel/contextual-turn';

const ChatPanel = lazy(() => import('../thoughts/ThoughtsChatPanel').then((module) => ({ default: module.ThoughtsChatPanel })));
interface ReplyMemory { draft: string; threadId: string | null }
const EMPTY_MEMORY: ReplyMemory = { draft: 'Help me draft a reply.', threadId: null };

/** One floating conversation at a time; drafts and saved threads survive switching. */
export function useMaintainerReplyChat(active: boolean) {
  const [context, setContext] = useState<MaintainerReplyContext | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [occlusion, setOcclusion] = useState(0);
  const [memories, setMemories] = useState<Record<string, ReplyMemory>>({});
  const launcher = useRef<HTMLElement | null>(null);
  const prepare = useCallback((next: MaintainerReplyContext) => {
    if (busy && next.key !== context?.key) { setNote('The current reply conversation is still running. Open it again to stop or finish the turn.'); return; }
    launcher.current = document.activeElement as HTMLElement | null;
    setNote(null); setContext(next); setVisible(true);
  }, [busy, context?.key]);
  const close = useCallback(() => {
    setVisible(false);
    const target = launcher.current;
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
  }, []);
  const rememberDraft = useCallback((draft: string) => {
    if (!context) return;
    setMemories((previous) => {
      const memory = previous[context.key] ?? EMPTY_MEMORY;
      return memory.draft === draft ? previous : { ...previous, [context.key]: { ...memory, draft } };
    });
  }, [context]);
  const rememberChrome = useCallback((chrome: ThoughtsChatPanelChromeState) => {
    if (!context || !chrome.threadId || !chrome.hasMessages) return;
    setMemories((previous) => {
      const memory = previous[context.key] ?? EMPTY_MEMORY;
      return memory.threadId === chrome.threadId ? previous : { ...previous, [context.key]: { ...memory, threadId: chrome.threadId } };
    });
  }, [context]);
  return { prepare, occlusion, conversation: <>
    {note ? <div role="status" style={{ padding: 12, color: 'var(--t-text-muted)', fontSize: 11, lineHeight: 1.4 }}>{note}</div> : null}
    {context ? <ReplySession key={context.key} context={context} memory={memories[context.key] ?? EMPTY_MEMORY} visible={active && visible} onClose={close} onDraftChange={rememberDraft} onChromeChange={rememberChrome} onBusyChange={setBusy} onOcclusionChange={setOcclusion} /> : null}
  </> };
}

function ReplySession({ context, memory, visible, onClose, onDraftChange, onChromeChange, onBusyChange, onOcclusionChange }: {
  context: MaintainerReplyContext; memory: ReplyMemory; visible: boolean; onClose: () => void;
  onDraftChange: (draft: string) => void; onChromeChange: (chrome: ThoughtsChatPanelChromeState) => void;
  onBusyChange: (busy: boolean) => void;
  onOcclusionChange: (height: number) => void;
}) {
  const data = useOrchestratorData();
  const panel = useRef<ThoughtsChatPanelHandle>(null);
  const surface = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const [preferredRuntime, setPreferredRuntime] = useState(readOrchestratorRuntimePreference);
  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);
  const [initialMemory] = useState(memory);
  const contextualConversation = useMemo(() => ({ requestContext: context.requestContext, modelDefaults: REPLY_MODEL_DEFAULTS, initialDraft: initialMemory.draft, onDraftChange, onBusyChange, placeholder: 'Ask for a draft, or refine your reply…' }), [context.requestContext, initialMemory.draft, onDraftChange, onBusyChange]);
  const focusWanted = useRef(visible);
  const attachPanel = useCallback((handle: ThoughtsChatPanelHandle | null) => {
    panel.current = handle;
    if (!handle || !focusWanted.current) return;
    if (!restored.current) { restored.current = true; if (initialMemory.threadId) handle.loadThread(initialMemory.threadId); }
    focusWanted.current = false;
    window.requestAnimationFrame(() => handle.focusInput());
  }, [initialMemory.threadId]);
  useEffect(() => {
    focusWanted.current = visible;
    if (visible) attachPanel(panel.current);
  }, [attachPanel, visible]);
  useLayoutEffect(() => {
    if (!visible || !surface.current) { onOcclusionChange(0); return; }
    const node = surface.current;
    const measure = () => onOcclusionChange(node.getBoundingClientRect().height + 24);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => { observer.disconnect(); onOcclusionChange(0); };
  }, [onOcclusionChange, visible]);
  return <FloatingSurface ref={surface} overlay role="dialog" aria-modal={false} aria-label={`Prepare reply · ${context.label}`} data-maintainer-reply-chat="" inert={!visible} onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }} style={{ position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 5, height: 'min(520px, calc(100% - 162px))', minHeight: 200, borderRadius: 18, display: visible ? 'block' : 'none' }} contentStyle={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 54, flexShrink: 0, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 14, borderBottom: '1px solid var(--t-divider-subtle)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text)' }}>Prepare reply</div>
        <div title={context.title} style={{ fontSize: 10.5, color: 'var(--t-text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{context.label}</div>
      </div>
      <button type="button" title="Open thread on GitHub" aria-label="Open reply thread on GitHub" onClick={() => { void openExternalUrl(context.url); }} style={iconStyle}><ExternalLink size={14} aria-hidden="true" /></button>
      <button type="button" title="Close reply conversation" aria-label="Close reply conversation" onClick={onClose} style={iconStyle}><X size={16} aria-hidden="true" /></button>
    </header>
    <OrchestratorContextResidencyProvider>
      <Suspense fallback={<div role="status" style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Opening conversation…</div>}>
        {data ? <ChatPanel ref={attachPanel} open={visible} contextualConversation={contextualConversation} agents={data.agents} missionState={data.missionState} preferredRuntime={preferredRuntime} sessionTargets={buildAgentTargets(data.agents, preferredRuntime)} workspaceTargets={data.workspaceTargets ?? []} repoPath={context.repoPath} scopeTabId={`inbox:${context.key}`} composerModeStorageId={`inbox:${context.key}`} projectId={data.activeProjectId ?? null} repoLabel={context.repoPath.split('/').filter(Boolean).pop()} thoughtsBodyBackground="transparent" thoughtsElevatedSurface="var(--t-glass-elevated)" thoughtsElevatedBorder="1px solid var(--t-glass-border-strong)" thoughtsElevatedShadow="var(--t-glass-shadow)" thoughtsMutedGlass="var(--t-glass-muted-strong)" lockedMode="fleet" initialMode="fleet" suppressAutoRestore suppressRuntimePrewarm showInlineExport={false} onMissionStateChange={data.onMissionStateChange} onLaunchPacket={data.onLaunchPacket} onChromeChange={onChromeChange} emptyStateOverride={<div style={{ padding: 16, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>Read the discussion with your orchestrator, then refine the draft here before posting.</div>} /> : <div role="status" style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Open a workspace to prepare this reply.</div>}
      </Suspense>
    </OrchestratorContextResidencyProvider>
  </FloatingSurface>;
}
const iconStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flexShrink: 0, border: 0, padding: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' } as const;
