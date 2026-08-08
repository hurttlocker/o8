'use client';

import { useCallback, useEffect, useState } from 'react';

import { canUseTauriEvents, resolveDesktopClose } from '@/lib/tauri/bridge';
import {
  APP_FONT_STACK,
  RamsButton,
  SettingsToggleButton,
} from '@/components/desktop/settings/shared';

interface DesktopCloseRequest {
  workingCount: number | null;
}

export function DesktopCloseCoordinator() {
  const [request, setRequest] = useState<DesktopCloseRequest | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<'background' | 'quit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canUseTauriEvents()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<DesktopCloseRequest>('desktop-close-requested', (event) => {
        if (disposed) return;
        setRequest(event.payload);
        setRemember(false);
        setBusy(null);
        setError(null);
      });
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const resolve = useCallback(async (action: 'background' | 'quit') => {
    setBusy(action);
    setError(null);
    const accepted = await resolveDesktopClose(action, remember);
    if (accepted) {
      setRequest(null);
      return;
    }
    setBusy(null);
    setError('o8 could not apply that close choice. Try again.');
  }, [remember]);

  if (!request) return null;

  const count = request.workingCount;
  const title = count == null
    ? 'Agents may still be working'
    : `${count} ${count === 1 ? 'agent is' : 'agents are'} still working`;
  const detail = count == null
    ? 'o8 could not verify the current agent state. You can keep it available from the system tray or stop its background processes and quit.'
    : 'Keep o8 available from the system tray, or stop the active background processes and quit.';

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        background: 'rgba(0, 0, 0, 0.32)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-close-title"
        aria-describedby="desktop-close-detail"
        style={{
          width: 'min(440px, 100%)',
          borderRadius: 16,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-bg-card)',
          boxShadow: '0 24px 72px rgba(0, 0, 0, 0.24)',
          color: 'var(--t-text)',
          fontFamily: APP_FONT_STACK,
          overflow: 'hidden',
        }}
      >
        <div style={{
          paddingTop: 22,
          paddingRight: 22,
          paddingBottom: 18,
          paddingLeft: 22,
        }}>
          <h2
            id="desktop-close-title"
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              lineHeight: 1.25,
            }}
          >
            {title}
          </h2>
          <p
            id="desktop-close-detail"
            style={{
              marginTop: 8,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              color: 'var(--t-text-faint)',
              fontSize: 13,
              fontWeight: 300,
              lineHeight: 1.55,
            }}
          >
            {detail}
          </p>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            marginTop: 20,
            paddingTop: 14,
            borderTop: '1px solid var(--t-divider)',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 400 }}>Remember my choice</div>
              <div style={{ marginTop: 2, color: 'var(--t-text-faint)', fontSize: 11.5, lineHeight: 1.4 }}>
                You can change this later in General settings.
              </div>
            </div>
            <SettingsToggleButton
              checked={remember}
              onChange={setRemember}
              disabled={busy !== null}
              activeLabel="Remember close choice"
              inactiveLabel="Ask next time"
            />
          </div>
          {error ? (
            <div role="alert" style={{ marginTop: 12, color: '#d94f3a', fontSize: 12 }}>
              {error}
            </div>
          ) : null}
        </div>
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          paddingTop: 14,
          paddingRight: 18,
          paddingBottom: 16,
          paddingLeft: 18,
          borderTop: '1px solid var(--t-divider)',
          background: 'var(--t-bg-subtle)',
        }}>
          <RamsButton
            variant="danger"
            disabled={busy !== null}
            busy={busy === 'quit'}
            onClick={() => { void resolve('quit'); }}
          >
            Stop and quit
          </RamsButton>
          <RamsButton
            disabled={busy !== null}
            busy={busy === 'background'}
            onClick={() => { void resolve('background'); }}
          >
            Keep working in the background
          </RamsButton>
        </div>
      </div>
    </div>
  );
}
