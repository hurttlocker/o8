'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DesktopWebSocketProvider, useSharedDesktopWs } from '../hooks/DesktopWebSocketContext';
import { XtermPanel, type XtermPanelHandle } from '../workspace-terminal/XtermPanel';
import { onboardingButtonStyle, onboardingQuietButtonStyle } from './onboarding-style';

function SignInTerminal({ command, onClose }: { command: string; onClose: () => void }) {
  const [ownerKey] = useState(() => `onboarding-sign-in:${crypto.randomUUID()}`);
  const [session, setSession] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const panelRef = useRef<XtermPanelHandle>(null);
  const requested = useRef(false);
  const [attached, setAttached] = useState(false);
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState({ connected: false, epoch: 0 });
  const ws = useSharedDesktopWs(undefined, {
    onTerminalCreated: (name, requestId) => {
      if (requestId !== ownerKey) return;
      sessionRef.current = name; setSession(name);
    },
    onTerminalAttached: (name) => { if (name === sessionRef.current) setAttached(true); },
    onTerminalData: (name, data) => { if (name === sessionRef.current) panelRef.current?.writeData(data); },
    onTerminalDimensions: (name, cols, rows) => { if (name === sessionRef.current) panelRef.current?.setSourceDimensions?.(cols, rows); },
    onTerminalVisibilityReady: (name, value) => { if (name === sessionRef.current) panelRef.current?.visibilityReady?.(value); },
    onTerminalResync: (name, data, value, truncated, source) => { if (name === sessionRef.current) panelRef.current?.applyResync?.(data, value, truncated, source); },
    onTerminalError: (name) => { if (!name || name === sessionRef.current) { setError('The sign-in terminal is unavailable. Copy the command above and run it in your own terminal.'); setAttached(false); } },
    onTerminalExited: (name) => { if (name === sessionRef.current) { panelRef.current?.setExited(); setAttached(false); setError('The terminal closed. Check sign-in above, or close this terminal and open a new one.'); } },
  });
  const { isConnected, sendTerminalCreate, sendAgentKill } = ws;
  if (connection.connected !== isConnected) {
    // A new transport must receive an attachment acknowledgement before Run is enabled.
    setConnection({ connected: isConnected, epoch: connection.epoch + (isConnected ? 1 : 0) });
    setAttached(false);
  }
  useEffect(() => {
    if (!isConnected) { requested.current = false; return; }
    if (sessionRef.current || requested.current) return;
    requested.current = true;
    sendTerminalCreate(90, 12, ownerKey, undefined, ownerKey, true);
  }, [isConnected, ownerKey, sendTerminalCreate]);
  useLayoutEffect(() => () => {
    // Terminate this view's PTY before the provider's passive socket teardown.
    if (sessionRef.current) sendAgentKill(sessionRef.current, 'SIGTERM');
  }, [sendAgentKill]);
  const run = () => {
    if (!session || !attached || !isConnected || startedRef.current) return;
    startedRef.current = true; setStarted(true);
    ws.sendTerminalInput(session, `${command}\r`);
    panelRef.current?.focus();
  };
  return <div data-onboarding-sound="silent" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <p role="status" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{error || (!isConnected ? 'Connecting to the sign-in terminal… You can also copy the command above.' : !attached ? 'Opening a fresh terminal…' : started ? 'Follow the tool’s instructions here. Readiness is checked separately.' : 'Terminal ready. Run the displayed command when you’re ready to sign in.')}</p>
    {session ? <div role="region" aria-label="Sign-in terminal" style={{ height: 220, minWidth: 0, overflow: 'hidden', border: '1px solid var(--t-divider)', borderRadius: 10 }}>
      <XtermPanel ref={panelRef} tmuxSession={session} visible screenReaderMode inputLocked={!started || !isConnected} connectionEpoch={connection.epoch}
        sendTerminalAttach={ws.sendTerminalAttach} sendTerminalInput={ws.sendTerminalInput} sendTerminalResize={ws.sendTerminalResize}
        sendTerminalVisibility={ws.sendTerminalVisibility} sendTerminalDetach={ws.sendTerminalDetach} />
    </div> : null}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {!started ? <button type="button" disabled={!attached || !isConnected} onClick={run} style={onboardingButtonStyle}>Run sign-in command</button> : null}
      <button type="button" onClick={onClose} style={onboardingQuietButtonStyle}>Close terminal</button>
    </div>
  </div>;
}

/** The sign-in surface connects only after the operator opens this terminal. */
export function OnboardingSignInTerminal(props: { command: string; onClose: () => void }) {
  return <DesktopWebSocketProvider><SignInTerminal {...props} /></DesktopWebSocketProvider>;
}
