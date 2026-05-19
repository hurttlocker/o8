'use client';

/**
 * /preview/shell — dev scaffold rendering the #1089 per-column header strips
 * (LeftHeaderStrip / WorkspaceHeaderStrip / PanelHeaderStrip) side by side.
 * A screenshot / iteration harness — not part of the shipped app chrome.
 */

import { useState } from 'react';
import { ThemeProvider } from '@/lib/theme/context';
import { LeftHeaderStrip } from '@/components/desktop/shell/LeftHeaderStrip';
import { WorkspaceHeaderStrip } from '@/components/desktop/shell/WorkspaceHeaderStrip';
import { PanelHeaderStrip } from '@/components/desktop/shell/PanelHeaderStrip';
import type { O8Tab } from '@/components/desktop/o8-panel/types';

function ShellPreviewInner() {
  const [sidebar, setSidebar] = useState(true);
  const [terminal, setTerminal] = useState(true);
  const [agents, setAgents] = useState(true);
  const [o8Tab, setO8Tab] = useState<O8Tab>('workspace');

  const colBorder = '1px solid var(--t-divider)';
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--t-bg)' }}>
      {/* Three per-column header strips, aligned in one row */}
      <div style={{ display: 'flex' }}>
        <div style={{ width: 260, borderRight: colBorder }}>
          <LeftHeaderStrip sidebarVisible={sidebar} onToggleSidebar={() => setSidebar((v) => !v)} />
        </div>
        <div style={{ flex: 1, borderRight: colBorder }}>
          <WorkspaceHeaderStrip
            isAgentsSectionActive={agents}
            onOpenAgents={() => setAgents((v) => !v)}
            bottomPanelVisible={terminal}
            onToggleBottomPanel={() => setTerminal((v) => !v)}
          />
        </div>
        <div style={{ width: 440 }}>
          <PanelHeaderStrip
            o8PanelVisible
            o8ActiveTab={o8Tab}
            onO8TabChange={setO8Tab}
            onOpenBrowser={() => {}}
          />
        </div>
      </div>
      {/* Mock column bodies so the strips read in context */}
      <div style={{ flex: 1, display: 'flex' }}>
        <div style={{ width: 260, borderRight: colBorder }} />
        <div style={{ flex: 1, borderRight: colBorder }} />
        <div style={{ width: 440 }} />
      </div>
    </div>
  );
}

export default function ShellPreviewPage() {
  return (
    <ThemeProvider>
      <ShellPreviewInner />
    </ThemeProvider>
  );
}
