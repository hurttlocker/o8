'use client';

import { useState, type CSSProperties } from 'react';
import { SubagentDemoPanel } from '@/components/desktop/workspace-terminal/SubagentDemoPanel';
import { SwarmStatusCard } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import { ComposerPicker } from '@/components/desktop/thoughts/composer-selector/ComposerPicker';
import { resolveComposerSelectorState } from '@/components/desktop/thoughts/composer-selector/state';
import { COMPOSER_MODEL_GROUPS } from '@/components/desktop/thoughts/ModelThinkingChip';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { getPalette, resolveTheme } from '@/lib/theme/registry';

const packets: OrchestratorPacket[] = [
  {
    id: 'preview-layout', title: 'Refine the composer layout', summary: 'Align the controls', referenceLabel: 'Preview',
    workspaceTargetPath: '', branchTarget: '', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'running',
    lane: { laneId: 'preview-layout', tileId: 'preview-layout', tabId: 'preview-layout', repoPath: '', runtime: 'codex' },
  },
  {
    id: 'preview-review', title: 'Review keyboard navigation', summary: 'Verify focus order', referenceLabel: 'Preview',
    workspaceTargetPath: '', branchTarget: '', runtime: 'claude-code', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'awaiting_review',
    lane: { laneId: 'preview-review', tileId: 'preview-review', tabId: 'preview-review', repoPath: '', runtime: 'claude-code' },
  },
];

/** Production components with illustrative receipts; selections stay in local React state. */
export function SubagentsPreview() {
  const [dark, setDark] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [chatDemo, setChatDemo] = useState(false);
  const [opened, setOpened] = useState('');
  const theme = resolveTheme(getPalette(dark ? 'dark' : 'light'), 'solid');
  const state = resolveComposerSelectorState({
    mode: 'multitask', leadBackend: 'codex', leadModelId: '', leadModelLabel: 'Codex',
    operatorDefaultEffort: 'high', inSessionEffortByModel: {}, threadEffortByModel: {}, adaptiveEnabled: true,
  });
  const button: CSSProperties = { border: '1px solid var(--t-border)', borderRadius: 8, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, background: 'var(--t-input-bg)', color: 'var(--t-text)', cursor: 'pointer', fontWeight: 300 };
  return <main style={{ minHeight: '100vh', padding: 24, background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <style>{`:root { ${Object.entries(theme.cssVars).map(([key, value]) => `${key}: ${value};`).join(' ')} }`}</style>
    <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
      <button style={button} onClick={() => setDark(value => !value)}>{dark ? 'Light' : 'Dark'} theme</button>
      <button style={button} onClick={() => setNarrow(value => !value)}>{narrow ? 'Wide' : 'Narrow'} view</button>
      <button style={button} onClick={() => setChatDemo(value => !value)}>{chatDemo ? 'Card preview' : 'Open chat demo'}</button>
    </div>
    {chatDemo ? <div style={{ height: 'calc(100vh - 110px)', maxWidth: narrow ? 360 : undefined, marginTop: 0, marginRight: 'auto', marginBottom: 0, marginLeft: 'auto' }}><SubagentDemoPanel onClose={() => setChatDemo(false)} /></div> : <section style={{ maxWidth: narrow ? 340 : 640, marginTop: 0, marginRight: 'auto', marginBottom: 0, marginLeft: 'auto' }}>
      <h1 style={{ fontSize: 18, fontWeight: 300 }}>Subagents</h1>
      <p style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Development preview with illustrative task receipts. No workers are launched; selections stay on this page.</p>
      <SwarmStatusCard packets={packets} scouts={[{ id: 'preview-native', label: 'Inspect existing patterns', status: 'unknown' }]} onFocusPacket={packet => setOpened(packet.title)} />
      <p role="status" style={{ minHeight: 18, fontSize: 12 }}>{opened ? `Selected: ${opened}` : ''}</p>
      <div style={{ border: '1px solid var(--t-border)', borderRadius: 16, background: 'var(--t-input-bg)', padding: 12 }}>
        <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: 'var(--t-text-muted)' }}>Describe the next task…</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <ComposerPicker state={state} composerModelGroups={COMPOSER_MODEL_GROUPS}
            onEffortChange={() => {}} />
        </div>
      </div>
    </section>}
  </main>;
}
