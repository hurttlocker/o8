'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SwarmStatusCard } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import { WorkersChip } from '@/components/desktop/thoughts/composer-selector/ComposerSelectorChips';
import { ProviderMarkGlyph } from '@/components/desktop/thoughts/composer-selector/provider-marks';
import { composerRuntimeLabel, providerMarkForRuntime } from '@/components/desktop/thoughts/composer-selector/state';
import { orchestratorStatusTone, packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { WorkerReviewAction } from '@/components/desktop/workspace-terminal/WorkerReviewAction';
import { demoPacket, initialDemoPackets, type DemoRuntime } from '@/components/desktop/workspace-terminal/subagent-demo';

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

/** Local-only rehearsal. Never dispatches, persists settings, or enters the live session registry. */
export function SubagentDemoPanel({ onClose }: { onClose: () => void }) {
  const [packets, setPackets] = useState(initialDemoPackets);
  const [selectedId, setSelectedId] = useState('demo-layout');
  const [runtime, setRuntime] = useState<DemoRuntime>('codex');
  const [override, setOverride] = useState<DemoRuntime | ''>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectionSource, setSelectionSource] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const workerRef = useRef<HTMLButtonElement>(null);
  const selected = packets.find(packet => packet.id === selectedId)!;
  const added = packets.some(packet => packet.id === 'demo-next');
  useEffect(() => { closeRef.current?.focus(); }, []);

  const reset = () => {
    setPackets(initialDemoPackets()); setSelectedId('demo-layout'); setRuntime('codex');
    setOverride(''); setPickerOpen(false); setReviewOpen(false); setSelectionSource('');
  };
  const openWorker = (packet: OrchestratorPacket) => { setSelectedId(packet.id); setReviewOpen(false); };
  const updateStatus = (status: OrchestratorPacket['status']) => {
    setReviewOpen(false);
    setPackets(current => current.map(packet => packet.id === selectedId
      ? { ...packet, status, blockedReason: status === 'failed' ? 'Demo verification failed. Work remains available.' : undefined }
      : packet));
  };
  const addTask = () => {
    if (added) return;
    const packet = demoPacket('demo-next', 'Check the final interaction', override || runtime);
    setPackets(current => [...current, packet]); openWorker(packet);
    setSelectionSource(override ? 'Task override' : 'Default worker at delegation');
  };
  const tone = orchestratorStatusTone(selected.status);

  return <section aria-label="Subagent workspace demo" data-subagent-demo style={{
    display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', minWidth: 0,
    background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
  }} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (pickerOpen) { setPickerOpen(false); workerRef.current?.focus(); } else onClose();
  }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, borderBottom: '1px solid var(--t-border)' }}>
      <span style={{ fontSize: 14, fontWeight: 300, marginRight: 'auto' }}>Subagents in a workspace</span>
      <span style={caption}>Development demo</span>
      <button type="button" style={button} onClick={reset}>Reset demo</button>
      <button ref={closeRef} type="button" style={button} onClick={onClose}>Back to live</button>
    </header>
    <div style={{ overflowY: 'auto', scrollbarWidth: 'none', minHeight: 0, padding: 16, flex: 1 }}>
      <p style={{ ...caption, marginTop: 0, marginBottom: 16 }}>Try the real card and worker chip with illustrative tasks. No workers, files, settings, or provider calls are changed.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 12 }}>
        <div style={pane}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--t-border)', fontSize: 12 }}>Orchestrator</div>
          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 13, lineHeight: 1.6, fontWeight: 300, marginTop: 0 }}>Refine the composer and check its keyboard navigation.</p>
            <p style={{ ...caption, marginBottom: 16 }}>Each delegated task keeps its own worker and state. Open a row to inspect it beside the conversation.</p>
            <SwarmStatusCard packets={packets} defaultExpanded onFocusPacket={openWorker}
              scouts={[{ id: 'demo-native', label: 'Inspect existing patterns', status: 'unknown' }]} />
            <div style={{ marginTop: 24, padding: 12, border: '1px solid var(--t-border)', borderRadius: 12, background: 'var(--t-input-bg)' }}>
              <div style={{ fontSize: 13, fontWeight: 300, marginBottom: 12 }}>Check the final interaction</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={caption}>Default worker</span>
                <WorkersChip mode="multitask" runtime={runtime} model={null} open={pickerOpen} saving={false} buttonRef={workerRef} onClick={() => setPickerOpen(value => !value)} />
              </div>
              {pickerOpen ? <div role="group" aria-label="Demo default worker choices" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {(['codex', 'claude-code'] as const).map(choice => <button key={choice} type="button" style={button} aria-pressed={runtime === choice} onClick={() => { setRuntime(choice); setPickerOpen(false); workerRef.current?.focus(); }}>{composerRuntimeLabel(choice)}</button>)}
              </div> : null}
              <p style={{ ...caption, marginBottom: 12 }}>Changing the default affects the next task. Existing workers keep their selection. These two choices are demo examples.</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <select aria-label="Runtime for demo task" value={override} onChange={event => setOverride(event.target.value as DemoRuntime | '')} style={{ ...button, maxWidth: '100%' }}>
                  <option value="">Use default for this task</option>
                  <option value="codex">This task: Codex</option>
                  <option value="claude-code">This task: Claude Code</option>
                </select>
                <button type="button" disabled={added} onClick={addTask} style={{ ...button, opacity: added ? 0.5 : 1 }}>{added ? 'Demo task added' : 'Add demo task'}</button>
              </div>
            </div>
          </div>
        </div>
        <section aria-label="Selected demo worker" data-demo-worker={selected.id} style={pane}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: '1px solid var(--t-border)' }}>
            <ProviderMarkGlyph mark={providerMarkForRuntime(selected.runtime)} />
            <span style={{ fontSize: 12, flex: 1 }}>{packetRuntimeModelDisplayLabel(selected)}</span>
            <span style={{ ...caption, display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 5, height: 5, borderRadius: 999, background: tone.dot }} />{selected.status === 'awaiting_review' ? 'Awaiting review' : tone.label}</span>
            <WorkerReviewAction packet={selected} onOpenReview={() => setReviewOpen(value => !value)} />
          </header>
          <div style={{ padding: 16 }}>
            <p style={{ ...caption, marginTop: 0 }}>SIMULATED WORKER · {selected.id === 'demo-next' ? selectionSource : 'Explicit task assignment'}</p>
            <h2 style={{ fontSize: 15, fontWeight: 300, lineHeight: 1.4 }}>{selected.title}</h2>
            <p role="status" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{selected.status === 'failed'
              ? selected.blockedReason
              : selected.status === 'awaiting_review' ? 'The worker returned its result. Review and acceptance are still separate steps.'
                : 'The worker is checking this task. Its runtime stays attached to this task when the default changes.'}</p>
            {reviewOpen ? <div style={{ border: '1px solid var(--t-border)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5 }}>Illustrative review receipt. No merge or acceptance is recorded. In live work, this action opens the task’s actual review.</div> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
              <button type="button" onClick={() => updateStatus('running')} style={button}>Simulate running</button>
              <button type="button" onClick={() => updateStatus('failed')} style={button}>Simulate failure</button>
              <button type="button" onClick={() => updateStatus('awaiting_review')} style={button}>Simulate finish</button>
            </div>
            <p style={{ ...caption, marginTop: 24 }}>Native subagents stay with their parent conversation. An unconfirmed result does not become “done” just because the parent stopped.</p>
          </div>
        </section>
      </div>
    </div>
  </section>;
}
