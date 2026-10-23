'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { SessionPaneFrame } from '@/components/desktop/workspace-terminal/SessionPaneFrame';
import { WorkerPaneHeader, WORKER_ICON_BUTTON } from '@/components/desktop/workspace-terminal/WorkerPaneHeader';
import { WorkerPaneComposer } from '@/components/desktop/workspace-terminal/WorkerPaneComposer';
import { useWorkerPaneSize } from '@/components/desktop/workspace-terminal/useWorkerPaneSize';
import { shortWorkerTitle, workerAttention } from '@/components/desktop/workspace-terminal/worker-pane-chrome';
import { TabBar } from '@/components/desktop/workspace-terminal/TabBar';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';

interface Fixture {
  label?: string; branch: string; issue?: number; status: string; reason?: string; prose: string;
}
const fixtures: Fixture[] = [
  { label: 'Repair worker input', branch: 'issue/4080-repair-worker-input', issue: 4080, status: 'running', prose: 'The input now keeps its draft while the worker reconnects. I’m checking the retry path before the final diff.' },
  { branch: 'inline/117313077011567-fix-the-linux-ci-regression-on-pr-408', status: 'running', prose: 'I found the failing check. The change is limited to the test setup, and the focused suite is running.' },
  { label: 'Check compact layouts', branch: 'issue/4081-check-compact-layouts', status: 'paused', prose: 'The compact layout is ready. Resume when you want me to check the remaining pane sizes.' },
  { label: 'Verify the pane frame', branch: 'inline/10928-verify-the-pane-frame', status: 'blocked', reason: 'CI', prose: 'The focused tests passed. The remote check needs attention before I can continue.' },
  { label: 'Review tab labels', branch: 'issue/4082-review-tab-labels', issue: 4082, status: 'awaiting_review', prose: 'Repeated tabs now show their task titles. The branch remains available in the tooltip.' },
  { label: 'Trace the handoff', branch: 'inline/10930-trace-the-handoff', status: 'waiting', prose: 'The handoff is ready. Which of the two recovery paths should I verify next?' },
  { label: 'Preserve draft text', branch: 'inline/10931-preserve-draft-text', status: 'running', prose: 'I’m testing the connection boundary with an unsent draft in place.' },
  { label: 'Verify keyboard input', branch: 'issue/4083-verify-keyboard-input', status: 'running', prose: 'Enter sends the message. Shift+Enter keeps the next line in the same draft.' },
  { label: 'Inspect the final diff', branch: 'inline/10933-inspect-the-final-diff', status: 'paused', prose: 'The change stays within the pane frame. I’ve left the transcript rendering untouched.' },
];

function FixturePane({ fixture }: { fixture: Fixture }) {
  const { paneRef, compact } = useWorkerPaneSize();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState(fixture.status);
  const [hidden, setHidden] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const title = shortWorkerTitle({ label: fixture.label, branch: fixture.branch });
  const attention = workerAttention(status, fixture.reason);
  return <SessionPaneFrame>
    <div ref={paneRef} data-worker-pane data-compact={compact} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {hidden ? <button type="button" onClick={() => setHidden(false)} style={{ color: 'var(--t-text)', background: 'transparent', border: 0 }}>Restore {title}</button> : <>
        <WorkerPaneHeader title={title} branch={fixture.branch} issueNumber={fixture.issue} runtime="Codex" model="gpt-6-sol"
          compact={compact} status={status} statusLabel={status.replace(/_/g, ' ')} actions={<>
            {status === 'awaiting_review' ? <button type="button" aria-label="Review changes" onClick={() => setReviewOpen(true)} style={WORKER_ICON_BUTTON}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 4v16M18 4v5a6 6 0 0 1-6 6H6" /><circle cx="6" cy="4" r="2" /><circle cx="18" cy="4" r="2" /></svg>
            </button> : null}
            <button type="button" aria-label="Hide pane" onClick={() => setHidden(true)} style={WORKER_ICON_BUTTON}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </>} />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', paddingTop: 14, paddingRight: 12, paddingBottom: 12, paddingLeft: 12,
          fontSize: 13, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text)' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <span style={{ maxWidth: '80%', background: 'var(--t-hover)', borderRadius: 8, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8 }}>Check the change and report what remains.</span>
          </div>
          <div style={{ color: 'var(--t-text-muted)', fontSize: 12, marginBottom: 8 }}>Read 6 files · Ran 2 checks ›</div>
          <div>{fixture.prose}</div>
          {reviewOpen ? <div role="region" aria-label="Worker review fixture" style={{ marginTop: 8, color: 'var(--t-text-muted)', fontSize: 12 }}>
            Fixture review and checks
            <button type="button" onClick={() => setReviewOpen(false)} style={{ border: 0, background: 'transparent', color: 'var(--t-text)', fontSize: 12 }}>Close review</button>
          </div> : null}
        </div>
        <WorkerPaneComposer textareaRef={textareaRef} scopeKey={fixture.branch} active={false} compact={compact}
          input={input} onInputChange={setInput} canSend={Boolean(input.trim())} onSend={() => { setInput(''); setStatus('running'); }}
          disabled={status === 'blocked'} attention={attention} onResume={status === 'blocked' ? undefined : () => setStatus('running')}
          onStop={() => setStatus('paused')} onOpenReview={() => setReviewOpen(true)} />
      </>}
    </div>
  </SessionPaneFrame>;
}

function RepeatedTabs() {
  const [tabs, setTabs] = useState<TerminalTab[]>(['Repair worker input', 'Review the pane frame', 'Check compact layouts', 'Build exit:'].map((llmSummary, index) => ({
    id: `thread-${index}`, label: 'Orchestrator', kind: 'orchestrator', llmSummary, tmuxSession: null, createdAt: 0, lastActivity: 0,
  })));
  const [active, setActive] = useState(tabs[0].id);
  return <TabBar tabs={tabs} activeTabId={active} onSelectTab={setActive} onCloseTab={id => setTabs(current => current.filter(tab => tab.id !== id))}
    onNewTab={() => {}} onNewLLMChatTab={() => {}} />;
}

function PreviewContent() {
  const { paletteId, setPalette } = useTheme();
  return <main style={{ minHeight: '100vh', boxSizing: 'border-box', paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24,
    background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
      <h1 style={{ fontSize: 14, fontWeight: 300, marginTop: 0, marginBottom: 0 }}>Worker pane frame</h1>
      <button type="button" onClick={() => setPalette(paletteId === 'light' ? 'dark' : 'light')}
        style={{ height: 28, paddingTop: 0, paddingBottom: 0, paddingLeft: 10, paddingRight: 10, border: 0, borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text-muted)', fontSize: 12, cursor: 'pointer' }}>Switch theme</button>
      <span style={{ fontSize: 12, color: 'var(--t-text-faint)' }}>Local frame fixtures</span>
    </div>
    <section data-fixture="repeated-tabs" style={{ marginBottom: 24, minWidth: 0 }}><RepeatedTabs /></section>
    {([2, 3] as const).map(columns => <section key={columns} data-fixture={`grid-${columns}x${columns}`} style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)', marginTop: 0, marginBottom: 8 }}>{columns} × {columns} workers</h2>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: columns === 2 ? 380 : 278, gap: 8 }}>
        {fixtures.slice(0, columns * columns).map(fixture => <FixturePane key={fixture.branch} fixture={fixture} />)}
      </div>
    </section>)}
    <section data-fixture="wide-short">
      <h2 style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)', marginTop: 0, marginBottom: 8 }}>Short pane, compact by height</h2>
      <div style={{ height: 280, display: 'flex' }}><FixturePane fixture={fixtures[5]} /></div>
    </section>
  </main>;
}

const subscribe = () => () => {};
export function WorkerPanePreview() {
  // Status marks choose a random motion phase on mount. Mount fixtures on the client.
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <ThemeProvider>{mounted ? <PreviewContent /> : null}</ThemeProvider>;
}
