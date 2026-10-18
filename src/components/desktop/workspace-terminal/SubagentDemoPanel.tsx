'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AgentStatusDot } from '@/components/desktop/AgentStatusDot';
import { ComposerArea } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
import { InputButtons } from '@/components/desktop/thoughts/InputButtons';
import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
import { SwarmStatusCard, swarmPacketStatus } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import { WorkersChip } from '@/components/desktop/thoughts/composer-selector/ComposerSelectorChips';
import { ProviderMarkGlyph } from '@/components/desktop/thoughts/composer-selector/provider-marks';
import { composerRuntimeLabel, providerMarkForRuntime } from '@/components/desktop/thoughts/composer-selector/state';
import { packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { WorkerReviewAction } from '@/components/desktop/workspace-terminal/WorkerReviewAction';
import { allDemoPackets, DEMO_RUNTIMES, demoPacket, type DemoRuntime } from '@/components/desktop/workspace-terminal/subagent-demo';

const button: CSSProperties = {
  border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-input-bg)',
  color: 'var(--t-text-secondary)', paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10,
  fontSize: 11, fontWeight: 300, cursor: 'pointer', fontFamily: 'inherit',
};
const pane: CSSProperties = {
  flex: '1 1 320px', minWidth: 0, border: '1px solid var(--t-border)', borderRadius: 14,
  background: 'var(--t-chat-surface-bg, var(--t-panel))', overflow: 'hidden',
};
const caption: CSSProperties = { fontSize: 10, color: 'var(--t-text-muted)', lineHeight: 1.5 };
const firstPrompt = 'Delegate this work across the supported workers. Let me inspect each task and review the results.';

/** Local-only rehearsal through the real transcript. Never enters the live session registry. */
export function SubagentDemoPanel({ onClose }: { onClose: () => void }) {
  const [packets, setPackets] = useState<OrchestratorPacket[]>([]);
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([]);
  const [draft, setDraft] = useState(firstPrompt);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<DemoRuntime>('codex');
  const [override, setOverride] = useState<DemoRuntime | ''>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectionSources, setSelectionSources] = useState<Record<string, string>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const workerRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const selected = packets.find(packet => packet.id === selectedId);
  useEffect(() => { draftRef.current?.focus(); }, []);

  const reset = () => {
    setPackets([]); setMessages([]); setDraft(firstPrompt); setSelectedId(null); setRuntime('codex');
    setOverride(''); setPickerOpen(false); setReviewOpen(false); setSelectionSources({});
    draftRef.current?.focus();
  };
  const openWorker = (packet: OrchestratorPacket) => { setSelectedId(packet.id); setReviewOpen(false); };
  const updateStatus = (status: OrchestratorPacket['status'], merged = false) => {
    setReviewOpen(false);
    setPackets(current => current.map(packet => packet.id === selectedId
      ? { ...packet, status, releaseState: merged ? 'released' : 'pending',
        releaseStatePayload: merged ? { mergeCommit: 'demo-only-merge-receipt' } : null,
        blockedReason: status === 'failed' ? 'Demo verification failed. Work remains available.' : undefined }
      : packet));
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const first = packets.length === 0;
    const next = first ? allDemoPackets() : [demoPacket(`demo-next-${messages.length}`, 'Check the final interaction', override || runtime)];
    setMessages(current => [...current,
      { id: `demo-user-${current.length}`, role: 'user', text },
      { id: `demo-reply-${current.length}`, role: 'assistant', text: first
        ? `I’ll split this into ${next.length} demo tasks, one per supported worker runtime. Open a task below to follow its progress. Each result still needs review.`
        : `I’ll send this task to ${composerRuntimeLabel(override || runtime)}. The existing workers keep their assignments.` },
    ]);
    setPackets(current => [...current, ...next]);
    if (!first) {
      openWorker(next[0]);
      setSelectionSources(current => ({ ...current, [next[0].id]: override ? 'Task override' : 'Default worker at delegation' }));
    }
    setDraft('');
    draftRef.current?.focus();
  };
  const status = selected ? swarmPacketStatus(selected) : null;

  return <section aria-label="Subagent workspace demo" data-subagent-demo style={{
    display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', minWidth: 0,
    background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
  }} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (pickerOpen) { setPickerOpen(false); workerRef.current?.focus(); }
    else if (selected) { setSelectedId(null); draftRef.current?.focus(); }
    else onClose();
  }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, borderBottom: '1px solid var(--t-border)' }}>
      <span style={{ fontSize: 14, fontWeight: 300, marginRight: 'auto' }}>Orchestrator · Demo chat</span>
      <span style={caption}>Local rehearsal</span>
      <button type="button" style={button} onClick={reset}>Reset demo</button>
      <button ref={closeRef} type="button" style={button} onClick={onClose}>Back to live</button>
    </header>
    <div style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', scrollbarWidth: 'none', minHeight: 0, padding: 12, flex: 1 }}>
      <p style={{ ...caption, flexShrink: 0, marginTop: 0, marginBottom: 12 }}>Examples, not installed availability. Send a demo message to see the reply and delegation card. No real workers or provider calls.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12, flex: 1, minHeight: 0 }}>
        <section aria-label="Demo orchestrator conversation" style={{ ...pane, flexGrow: 2, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 180 }}>
          <div data-demo-transcript style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <ChatMessageList displayMessages={messages} displayWaiting={false} activeTargetLabel="Orchestrator"
              activeTargetColor="var(--t-accent)" thoughtsMutedGlass="var(--t-input-bg)"
              thoughtsElevatedBorder="var(--t-border)" thoughtsElevatedShadow="none" isOrchestratorMode
              emptyStateFallback={<div style={{ padding: 24 }}><p style={{ fontSize: 15, fontWeight: 300 }}>Start with a message</p><p style={caption}>Send the example below, then open any worker from the reply.</p></div>}
              bottomContent={packets.length ? <SwarmStatusCard packets={packets} defaultExpanded onFocusPacket={openWorker} /> : null} />
          </div>
        </section>
        {selected && status ? <section aria-label="Selected demo worker" data-demo-worker={selected.id} style={pane}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid var(--t-border)' }}>
            <ProviderMarkGlyph mark={providerMarkForRuntime(selected.runtime)} />
            <span style={{ fontSize: 12, flex: 1 }}>{packetRuntimeModelDisplayLabel(selected)}</span>
            <AgentStatusDot state={status.state} label={status.label} />
            <span style={caption}>{status.label}</span>
            <WorkerReviewAction packet={selected} onOpenReview={() => setReviewOpen(value => !value)} />
            <button type="button" aria-label="Close demo worker" onClick={() => { setSelectedId(null); draftRef.current?.focus(); }} style={button}>×</button>
          </header>
          <div style={{ padding: 16 }}>
            <p style={{ ...caption, marginTop: 0 }}>SIMULATED WORKER · {selectionSources[selected.id] || 'Explicit task assignment'}</p>
            <h2 style={{ fontSize: 15, fontWeight: 300, lineHeight: 1.4 }}>{selected.title}</h2>
            <p role="status" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{selected.status === 'failed' ? selected.blockedReason
              : selected.status === 'awaiting_review' ? 'The worker returned its result. Review and acceptance are still separate steps.'
                : selected.releaseState === 'released' ? 'A simulated merge receipt is recorded. No real repository changed.'
                  : 'The worker is checking this task. Its runtime stays attached when the default changes.'}</p>
            {reviewOpen ? <div style={{ border: '1px solid var(--t-border)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5 }}>Illustrative review receipt. No merge or acceptance is recorded. In live work, this action opens the task’s actual review.</div> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
              <button type="button" onClick={() => updateStatus('running')} style={button}>Simulate running</button>
              <button type="button" onClick={() => updateStatus('failed')} style={button}>Simulate failure</button>
              <button type="button" onClick={() => updateStatus('awaiting_review')} style={button}>Simulate finish</button>
              <button type="button" disabled={selected.status !== 'awaiting_review'} onClick={() => updateStatus('released', true)} style={{ ...button, opacity: selected.status === 'awaiting_review' ? 1 : 0.5 }}>Simulate reviewed merge</button>
            </div>
            <p style={{ ...caption, marginTop: 24 }}>The status mark is the same one used in the sidebar. Finishing work does not turn it into a merge.</p>
          </div>
        </section> : null}
      </div>
    </div>
    <ComposerArea ref={draftRef} activeComposer inputLabel="Message Orchestrator" placeholder="Message Orchestrator…" literalInput
      composerMode="multitask"
      input={draft} onInputChange={setDraft} onSubmit={send}
      isOrchestratorMode displayWaiting={false} chatMessages={messages}
      activeTargetLabel="Orchestrator" targetAgentExists thoughtsBodyBackground="var(--t-canvas-bg)"
      enhancing={false} preEnhanceInput={null} onEnhance={() => undefined} onUndoEnhance={() => undefined}
      onSlashCommand={command => setDraft(command)} modelLabel="Orchestrator" isolatedModelSelection
      effort="adaptive" onEffortChange={() => undefined} adaptiveEnabled
      displayMessagesCount={messages.length} hasAssistantActivity
      footerOverride={<InputButtons input={draft} onSubmit={send} modelLabel="Orchestrator"
        enhancing={false} preEnhanceInput={null} onEnhance={() => undefined} onUndoEnhance={() => undefined}
        inlineLeadingExtras={<WorkersChip mode="multitask" runtime={runtime} model={null}
          open={pickerOpen} saving={false} buttonRef={workerRef} onClick={() => setPickerOpen(value => !value)} />} />}
      contextLocationSlot={<>
        {packets.length ? <select aria-label="Runtime for demo task" value={override}
          onChange={event => setOverride(event.target.value as DemoRuntime | '')} style={{ ...button, maxWidth: '100%' }}>
          <option value="">Use default for next task</option>
          {DEMO_RUNTIMES.map(choice => <option key={choice} value={choice}>This task: {composerRuntimeLabel(choice)}</option>)}
        </select> : <span style={caption}>First message: all {DEMO_RUNTIMES.length} supported worker examples</span>}
        {pickerOpen ? <div role="group" aria-label="Demo default worker choices" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 140, overflowY: 'auto', scrollbarWidth: 'none' }}>
          {DEMO_RUNTIMES.map(choice => <button key={choice} type="button" style={button} aria-pressed={runtime === choice}
            onClick={() => { setRuntime(choice); setPickerOpen(false); workerRef.current?.focus(); }}>{composerRuntimeLabel(choice)}</button>)}
        </div> : null}
      </>} />
  </section>;
}
