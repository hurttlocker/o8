'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { ComposerArea } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
import { useTranscriptAutoScroll } from '@/components/desktop/thoughts/chat-panel/useTranscriptAutoScroll';
import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const noop = () => {};
const messages: MobileTranscriptEntry[] = [
  { id: 'request', role: 'user', text: 'Make the worker panes easier to scan in a small grid.', timestamp: 1 },
  { id: 'working', role: 'assistant', text: 'I’m checking the narrow layout and the header spacing.', timestamp: 2 },
];
function queued(id: string, text: string, applied = false): QueuedComposerSendRecord {
  return { id, sequence: 1, repoPath: '/workspace/project', threadId: `thoughts-preview-${id}`, intent: applied ? 'steer-now' : 'send-next',
    status: applied ? 'applied' : 'queued', reason: null, createdAt: 3, updatedAt: 3, admittedAt: applied ? 3 : null,
    payload: { text, wireMessage: text, images: [], routing: { backend: 'pi', model: 'pi', effort: 'medium', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } } };
}
function Fixture({ id, label, canSteer = true, initial }: { id: string; label: string; canSteer?: boolean; initial?: QueuedComposerSendRecord }) {
  const endRef = useRef<HTMLDivElement>(null); const suppressRef = useRef(false);
  useTranscriptAutoScroll({ endRef, suppressRef, scope: id });
  const [input, setInput] = useState('');
  const [items, setItems] = useState(initial ? [initial] : []);
  const send = (steer: boolean) => {
    if (!input.trim()) return;
    setItems(current => [...current, queued(`${id}-${current.length}`, input.trim(), steer)]); setInput('');
  };
  return <section data-fixture={id} style={{ minWidth: 0 }}>
    <h2 style={{ marginTop: 0, marginBottom: 10, fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)' }}>{label}</h2>
    <div style={{ height: 430, display: 'flex', flexDirection: 'column', border: '1px solid var(--t-divider)', borderRadius: 12, overflow: 'hidden', background: 'var(--t-bg-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, paddingLeft: 14, paddingRight: 14, fontSize: 12, fontWeight: 300, borderBottom: '1px solid var(--t-divider)' }}>
        <span aria-label="Working" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-success)' }} />
        <span style={{ flex: 1 }}>Compact worker panes</span><span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{canSteer ? 'Built-in agent' : 'Queue runtime'}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ChatMessageList ref={endRef} isOrchestratorMode displayMessages={messages} displayWaiting activeTargetLabel="Agent" activeTargetColor="var(--t-accent)"
          thoughtsMutedGlass="transparent" thoughtsElevatedBorder="var(--t-divider)" thoughtsElevatedShadow="none" emptyStateFallback={null}
          composerQueue={{ items, canSteer, onSteer: key => setItems(current => current.map(item => item.id === key ? { ...item, intent: 'steer-now', status: 'applied', admittedAt: Date.now() } : item)),
            onCancel: sequence => setItems(current => current.filter(item => item.sequence !== sequence)) }} />
      </div>
      <ComposerArea input={input} onInputChange={setInput} isOrchestratorMode displayWaiting chatMessages={messages}
        activeTargetLabel="Agent" targetAgentExists thoughtsBodyBackground="transparent" enhancing={false} preEnhanceInput={null}
        onEnhance={noop} onUndoEnhance={noop} onSubmit={() => send(false)} onSteer={() => send(true)} canSteerLive={canSteer}
        onStop={noop} onSlashCommand={noop} modelLabel={canSteer ? 'Built-in agent' : 'Queue runtime'} activeBackend="pi" modelId="pi" effort="medium" onEffortChange={noop}
        adaptiveEnabled={false} displayMessagesCount={messages.length + items.length} hasAssistantActivity composerMode="solo" />
    </div>
  </section>;
}
function Content() {
  const { paletteId, setPalette } = useTheme();
  return <main style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box', background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
      <h1 style={{ margin: 0, fontSize: 14, fontWeight: 300 }}>Messages during a running turn</h1>
      <button type="button" onClick={() => setPalette(paletteId === 'light' ? 'dark' : 'light')} style={{ border: 0, padding: 6, borderRadius: 6, background: 'var(--t-input-bg)', color: 'var(--t-text-muted)', cursor: 'pointer' }}>Switch theme</button>
      <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>Interactive fixtures</span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 24 }}>
      <Fixture id="steer-empty" label="Steer · ready for input" />
      <Fixture id="steer-sent" label="Steer · acknowledged" initial={queued('acknowledged', 'Keep the current spacing. Focus on the titles.', true)} />
      <Fixture id="queue" label="Queue · waiting for the next turn" initial={queued('waiting', 'Then check the same layout in light mode.')} />
      <Fixture id="queue-only" label="Runtime without live input" canSteer={false} initial={queued('queue-only', 'Check the smaller pane size next.')} />
    </div>
  </main>;
}
const subscribe = () => () => {};
export function ComposerSteerPreview() {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <ThemeProvider>{mounted ? <Content /> : null}</ThemeProvider>;
}
