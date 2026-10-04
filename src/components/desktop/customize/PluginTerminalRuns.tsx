'use client';

import { useState } from 'react';

export type PluginTerminalTarget = { sessionName: string; label: string; workspaceRoot: string | null };
export type PluginTerminalRun = PluginTerminalTarget & { id: string; pluginId: string; terminalId: string; revision: string; status: string; exitCode: number | null; error: string | null };

export function PluginTerminalRuns({ runs, busy, onOpen, onStop }: {
  runs: PluginTerminalRun[];
  busy: boolean;
  onOpen: (run: PluginTerminalRun) => void;
  onStop: (run: PluginTerminalRun) => void;
}) {
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  if (!runs.length) return null;
  const button = { borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 7, backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', paddingTop: 5, paddingBottom: 5, paddingLeft: 10, paddingRight: 10, fontSize: 12, cursor: 'pointer' };
  return <section aria-label="Plugin terminals" style={{ borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 12, paddingTop: 18, paddingBottom: 18, paddingLeft: 18, paddingRight: 18 }}>
    <div style={{ fontSize: 13, marginBottom: 10 }}>Plugin terminals</div>
    {runs.map((run) => <div key={run.id} style={{ borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider)', paddingTop: 12, paddingBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12 }}>{run.label} · {run.status}{run.exitCode === null ? '' : ` · exit ${run.exitCode}`}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={button} disabled={busy || !['running', 'exited'].includes(run.status)} onClick={() => onOpen(run)}>Open terminal</button>
          {confirmStop === run.id ? <><button type="button" style={{ ...button, color: 'var(--t-error)' }} disabled={busy} onClick={() => { setConfirmStop(null); onStop(run); }}>Confirm stop</button><button type="button" style={button} onClick={() => setConfirmStop(null)}>Cancel</button></> : <button type="button" style={{ ...button, color: 'var(--t-error)' }} disabled={busy || !['launching', 'running', 'exited'].includes(run.status)} onClick={() => setConfirmStop(run.id)}>Stop terminal</button>}
        </div>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>Session <code>{run.sessionName}</code> · revision <code>{run.revision.slice(0, 12)}</code></div>
      {confirmStop === run.id ? <div style={{ marginTop: 6, fontSize: 12, color: 'var(--t-error)' }}>Stop the process and discard this terminal’s retained output? Plugin saved data is kept.</div> : null}
      {run.error ? <div role="alert" style={{ marginTop: 6, fontSize: 12, color: 'var(--t-error)' }}>{run.error}</div> : null}
    </div>)}
  </section>;
}
