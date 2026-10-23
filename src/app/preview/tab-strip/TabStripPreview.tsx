'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { WorkspaceHeaderStrip } from '@/components/desktop/shell/WorkspaceHeaderStrip';
import type { WorkspaceHeaderTab } from '@/components/desktop/shell/workspace-header-strip-types';

function tab(id: string, label: string, llmSummary?: string): WorkspaceHeaderTab {
  return { id, label, llmSummary, kind: 'orchestrator', runtime: null, packetStatus: null };
}

const mixed = [
  { ...tab('pull', 'Pull the latest changes for'), kind: 'terminal' },
  tab('input', 'Orchestrator', 'Repair worker input'),
  tab('review', 'Orchestrator', 'Review the pane frame'),
  tab('layout', 'Orchestrator', 'Check compact layouts'),
  tab('exit-1', 'Build exit:'), tab('exit-2', 'Build exit:'), tab('empty', 'Orchestrator'),
];

const restored = [
  tab('active', 'Orchestrator', 'Check the active worker'),
  { ...tab('saved', 'Orchestrator', 'Trace the saved handoff'), orchestratorThreadId: 'thoughts-preview-saved' },
  { ...tab('untitled', 'Orchestrator', 'Repair the API connection'), orchestratorThreadId: 'thoughts-preview-untitled' },
  tab('empty-1', 'Orchestrator'), tab('empty-2', 'Orchestrator'),
];

const packets: WorkspaceHeaderTab[] = [
  { ...tab('issue', 'issue/4080-repair-worker-input'), kind: 'chat', orchestrationPacket: { title: 'Repair worker input', branchTarget: 'issue/4080-repair-worker-input' } },
  { ...tab('branch', 'inline/117313077011567-fix-the-linux-ci-regression-on-pr-408'), kind: 'chat' },
  { ...tab('custom', 'Release desk', 'Another task'), labelSource: 'user' },
  tab('phrase', 'Add support for'),
];

function StripFixture({ id, title, initialTabs, width }: {
  id: string; title: string; initialTabs: WorkspaceHeaderTab[]; width?: number;
}) {
  const [tabs, setTabs] = useState(initialTabs);
  const [active, setActive] = useState(initialTabs[0].id);
  useEffect(() => {
    const select = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; tabId: string }>).detail;
      if (detail?.workspaceId === id) setActive(detail.tabId);
    };
    const close = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; tabId: string }>).detail;
      if (detail?.workspaceId === id) setTabs(current => current.filter(tab => tab.id !== detail.tabId));
    };
    const rename = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; tabId: string; label: string }>).detail;
      if (detail?.workspaceId === id) setTabs(current => current.map(tab => tab.id === detail.tabId ? { ...tab, label: detail.label, labelSource: 'user' } : tab));
    };
    window.addEventListener('o8:request-select-tab', select);
    window.addEventListener('o8:request-close-tab', close);
    window.addEventListener('o8:request-rename-tab', rename);
    return () => {
      window.removeEventListener('o8:request-select-tab', select);
      window.removeEventListener('o8:request-close-tab', close);
      window.removeEventListener('o8:request-rename-tab', rename);
    };
  }, [id]);
  return <section data-fixture={id} style={{ marginBottom: 32 }}>
    <h2 style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)', marginTop: 0, marginBottom: 8 }}>{title}</h2>
    <div style={{ width: width ?? '100%', maxWidth: '100%', background: 'var(--t-bg-card)', borderRadius: 10, overflow: 'hidden' }}>
      <WorkspaceHeaderStrip headerTabs={tabs} headerActiveTabId={active} tabWorkspaceId={id} />
      <div style={{ padding: 24, minHeight: 48, fontSize: 13, fontWeight: 300, color: 'var(--t-text-muted)' }}>
        Select a tab to switch conversations. Double-click or press F2 to rename.
      </div>
    </div>
  </section>;
}

function PreviewContent() {
  const { paletteId, setPalette } = useTheme();
  return <main style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box', background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
      <h1 style={{ fontSize: 14, fontWeight: 300, margin: 0 }}>Workspace tabs</h1>
      <button type="button" onClick={() => setPalette(paletteId === 'light' ? 'dark' : 'light')}
        style={{ height: 28, paddingTop: 0, paddingBottom: 0, paddingLeft: 10, paddingRight: 10, border: 0, borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text-muted)', fontSize: 12, cursor: 'pointer' }}>Switch theme</button>
    </div>
    <StripFixture id="mixed" title="Seven conversations" initialTabs={mixed} />
    <StripFixture id="restored" title="Restored conversations and unnamed tabs" initialTabs={restored} width={1000} />
    <StripFixture id="packets" title="Issue packet, branch fallback and chosen title" initialTabs={packets} width={1000} />
  </main>;
}

const subscribe = () => () => {};
export function TabStripPreview() {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <ThemeProvider>{mounted ? <PreviewContent /> : null}</ThemeProvider>;
}
