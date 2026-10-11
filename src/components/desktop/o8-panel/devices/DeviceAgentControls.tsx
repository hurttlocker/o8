'use client';

import { useState } from 'react';
import type { DeviceState } from '@/lib/devices/types';

/** The viewer shares a real device; displaying it does not acquire an agent session. */
export function DeviceAgentControls({ state, disabled, onInstall, compact = false, statusMessage }: {
  state: DeviceState; disabled: boolean; onInstall: () => void; compact?: boolean; statusMessage?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const copy = async () => {
    if (!state.agentCommand) return;
    const command = state.agentCommand.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
    const instructions = [
      'Test the mobile app with the installed device helper:', `${command} --help`,
      `Inspect current owners first: ${command} session list`,
      'Use a distinct --session name for each orchestrator or worker, and an explicit --udid for the intended iOS simulator on open. Keep that same session on subsequent commands.',
      'Use the shared default daemon state directory. Do not override AGENT_DEVICE_STATE_DIR or reuse another worker’s session to bypass ownership.',
      'If the device is in use, wait or ask its owner to release it. Do not close another session or shut down its simulator.',
      'The viewer and manual input share the same phone. Coordinate with the user before tapping or typing. Opening another chat does not create a separate simulator.',
    ].join('\n\n');
    try { await navigator.clipboard.writeText(instructions); setCopied(true); setError(false); }
    catch { setError(true); }
  };
  const buttonStyle = { border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-glass-muted)', color: 'var(--t-text)', paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, fontSize: 11.5, cursor: 'pointer' };
  const content = <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, paddingTop: 8, maxHeight: compact ? '30vh' : undefined, overflowY: 'auto', scrollbarWidth: 'none', fontSize: 11.5, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
    <p style={{ margin: 0 }}>This is a shared phone. Chats and workers do not get separate simulators automatically. Coordinate manual input with the agent testing it.</p>
    <p style={{ margin: 0 }}>Use a distinct agent session for each worker. The helper refuses a second session on an occupied device; reusing the same session does not provide that protection.</p>
    {state.tools.agent.installed && state.agentCommand ? <button type="button" onClick={() => { void copy(); }} style={buttonStyle}>{copied ? 'Instructions copied' : 'Copy agent instructions'}</button>
      : compact ? <p style={{ margin: 0 }}>Stop the viewer to set up agent controls. The simulator will stay open.</p>
        : <button type="button" disabled={disabled} onClick={onInstall} style={buttonStyle}>Set up agent controls</button>}
    {error ? <span role="alert">Could not copy. Check clipboard access and try again.</span> : null}
  </div>;
  return compact ? <details style={{ paddingTop: 7, paddingRight: 16, paddingBottom: 7, paddingLeft: 16, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
    <summary title={statusMessage ?? undefined} style={{ fontSize: 11.5, color: 'var(--t-text-muted)', cursor: 'pointer' }}><span role="status">{statusMessage ? 'Connection delayed' : 'Shared device'}</span> · Agent controls</summary>{content}
  </details> : <div style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 16 }}><div style={{ fontSize: 12 }}>Agent controls</div>{content}</div>;
}
