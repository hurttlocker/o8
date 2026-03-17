'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Wifi, WifiOff } from 'lucide-react';
import { useDesktopWebSocket, type DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';

export function MobileTerminal({ tmuxSession }: { tmuxSession: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const [termError, setTermError] = useState<string | null>(null);
  const [termExited, setTermExited] = useState(false);
  const [attached, setAttached] = useState(false);

  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onTerminalAttached: (sessionName) => {
      if (sessionName !== tmuxSession) return;
      setAttached(true);
      setTermExited(false);
      setTermError(null);
    },
    onTerminalData: (sessionName, data) => {
      if (sessionName !== tmuxSession || !termRef.current) return;
      try {
        termRef.current.write(atob(data));
      } catch {
        // Ignore malformed chunks
      }
    },
    onTerminalExited: (sessionName) => {
      if (sessionName !== tmuxSession) return;
      setTermExited(true);
    },
    onTerminalError: (sessionName, error) => {
      if (sessionName && sessionName !== tmuxSession) return;
      setTermError(error);
    },
  }), [tmuxSession]);

  const {
    connectionState,
    isConnected,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  } = useDesktopWebSocket(undefined, wsCallbacks);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let observer: ResizeObserver | null = null;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        if (disposed) return;

        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/xterm.css';
          document.head.appendChild(link);
        }

        const term = new Terminal({
          fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          allowTransparency: true,
          scrollback: 4000,
          theme: {
            background: 'rgba(7, 10, 18, 0.96)',
            foreground: '#e5edf8',
            cursor: '#f8fafc',
            cursorAccent: '#0b1120',
            selectionBackground: 'rgba(59, 130, 246, 0.28)',
            black: '#0f172a',
            red: '#ef4444',
            green: '#34d399',
            yellow: '#f59e0b',
            blue: '#60a5fa',
            magenta: '#c084fc',
            cyan: '#22d3ee',
            white: '#e2e8f0',
            brightBlack: '#475569',
            brightRed: '#f87171',
            brightGreen: '#6ee7b7',
            brightYellow: '#fbbf24',
            brightBlue: '#93c5fd',
            brightMagenta: '#d8b4fe',
            brightCyan: '#67e8f9',
            brightWhite: '#f8fafc',
          },
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        if (!containerRef.current || disposed) {
          term.dispose();
          return;
        }

        term.open(containerRef.current);
        fitAddon.fit();
        term.focus();

        termRef.current = term;
        fitAddonRef.current = fitAddon;

        sendTerminalAttach?.(tmuxSession, term.cols, term.rows);

        term.onData((data: string) => {
          sendTerminalInput?.(tmuxSession, data);
        });

        observer = new ResizeObserver(() => {
          if (disposed || !termRef.current || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            sendTerminalResize?.(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch {
            // Ignore fit/resize races during orientation changes
          }
        });

        observer.observe(containerRef.current);
      } catch (error) {
        if (!disposed) {
          setTermError(error instanceof Error ? error.message : 'Failed to initialize terminal.');
        }
      }
    }

    void init();

    return () => {
      disposed = true;
      observer?.disconnect();
      sendTerminalDetach?.(tmuxSession);
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      setAttached(false);
    };
  }, [sendTerminalAttach, sendTerminalDetach, sendTerminalInput, sendTerminalResize, tmuxSession]);

  const statusLabel = termError
    ? 'error'
    : termExited
      ? 'exited'
      : attached
        ? 'attached'
        : isConnected
          ? 'attaching'
          : connectionState;

  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 18,
        border: '1px solid rgba(15, 23, 42, 0.08)',
        background: 'rgba(255, 255, 255, 0.82)',
        boxShadow: '0 18px 40px rgba(15, 23, 42, 0.08)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
          background: 'rgba(248, 250, 252, 0.94)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15, 23, 42, 0.06)',
            color: '#0f172a',
            flexShrink: 0,
          }}
        >
          <Monitor size={14} strokeWidth={2} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: '#0f172a',
              letterSpacing: '-0.01em',
            }}
          >
            Agent Terminal
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 10,
              color: '#64748b',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tmuxSession}
          </div>
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 8px',
            borderRadius: 999,
            background: termError ? 'rgba(239, 68, 68, 0.10)' : attached ? 'rgba(34, 197, 94, 0.10)' : 'rgba(59, 130, 246, 0.10)',
            color: termError ? '#b91c1c' : attached ? '#15803d' : '#1d4ed8',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {isConnected ? <Wifi size={11} strokeWidth={2} /> : <WifiOff size={11} strokeWidth={2} />}
          {statusLabel}
        </div>
      </div>

      <div
        onClick={() => termRef.current?.focus()}
        style={{
          position: 'relative',
          minHeight: '52vh',
          background: 'linear-gradient(180deg, rgba(7, 10, 18, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%)',
        }}
      >
        <div
          ref={containerRef}
          data-tmux-session={tmuxSession}
          style={{
            width: '100%',
            height: '52vh',
            padding: 10,
          }}
        />

        {!attached && !termError ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 999,
                background: 'rgba(15, 23, 42, 0.72)',
                border: '1px solid rgba(148, 163, 184, 0.18)',
                color: '#cbd5e1',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              Attaching to terminal…
            </div>
          </div>
        ) : null}
      </div>

      {(termError || termExited) ? (
        <div
          style={{
            padding: '10px 14px 12px',
            fontSize: 11,
            lineHeight: 1.5,
            color: termError ? '#b91c1c' : '#64748b',
            background: termError ? 'rgba(254, 242, 242, 0.8)' : 'rgba(248, 250, 252, 0.9)',
          }}
        >
          {termError ?? 'Terminal session exited. Re-select the agent to attach again.'}
        </div>
      ) : null}
    </div>
  );
}
