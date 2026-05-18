'use client';

/**
 * MobilePairingView — full-screen QR pairing surface, rendered as a Canvas tab.
 *
 * The native o8 mobile app (hurttlocker/o8-mobile) can't inherit the backend
 * address, so desktop emits a QR. This view fetches GET /api/panel/mobile-pairing
 * and renders a QR encoding `JSON.stringify({ host, apiPort, wsPort, token })` —
 * exactly the shape o8-mobile's scanner (src/app/pair-scan.tsx) parses.
 *
 * Opened by the phone-icon button in DesktopStatusBar. The token is encoded in
 * the QR (that's the point of pairing) but never printed on screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { Smartphone } from '../lucide-shims';
import { OPEN_SETTINGS_TAB_EVENT, type OpenSettingsTabDetail } from '@/lib/desktop/events';

const APP_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"iA Writer Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

interface PairingPayload {
  host: string | null;
  apiPort: number;
  wsPort: number;
  token: string;
  error?: string;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; host: string; apiPort: number; wsPort: number; qrDataUrl: string }
  | { status: 'error'; message: string };

export function MobilePairingView() {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/panel/mobile-pairing');
        const data = (await res.json().catch(() => null)) as PairingPayload | null;
        if (!res.ok || !data) {
          throw new Error(data?.error || `Pairing endpoint returned ${res.status}`);
        }
        if (!data.host) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: 'No local network address found. Connect this Mac to Wi-Fi, then retry.',
            });
          }
          return;
        }
        // The payload shape is the contract with o8-mobile's QR scanner —
        // exactly { host, apiPort, wsPort, token }, parsed via JSON.parse.
        const qrPayload = JSON.stringify({
          host: data.host,
          apiPort: data.apiPort,
          wsPort: data.wsPort,
          token: data.token,
        });
        const qrDataUrl = await toDataURL(qrPayload, {
          width: 480,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#0c0c0c', light: '#ffffff' },
        });
        if (!cancelled) {
          setState({
            status: 'ready',
            host: data.host,
            apiPort: data.apiPort,
            wsPort: data.wsPort,
            qrDataUrl,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Could not build a pairing code.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadKey((k) => k + 1);
  }, []);

  const openConnections = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent<OpenSettingsTabDetail>(OPEN_SETTINGS_TAB_EVENT, {
        detail: { tab: 'connections' },
      }),
    );
  }, []);

  const subtitle = state.status === 'loading'
    ? 'Preparing a one-time pairing code…'
    : state.status === 'error'
      ? 'Pairing is unavailable right now.'
      : 'Open o8 on your phone and scan this code. Your phone and this Mac must be on the same Wi-Fi network.';

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        background: 'var(--t-canvas-bg)',
        color: 'var(--t-text)',
        fontFamily: APP_FONT,
      }}
    >
      <div
        style={{
          margin: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 8,
          paddingTop: 48,
          paddingBottom: 48,
          paddingLeft: 32,
          paddingRight: 32,
          maxWidth: 420,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--t-bg-card)',
            border: '1px solid var(--t-divider-subtle)',
            color: 'var(--t-text-secondary)',
            marginBottom: 6,
          }}
        >
          <Smartphone size={20} />
        </div>

        <h2
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--t-text)',
          }}
        >
          Pair your phone
        </h2>

        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            fontWeight: 400,
            lineHeight: 1.5,
            color: 'var(--t-text-secondary)',
            maxWidth: 340,
          }}
        >
          {subtitle}
        </p>

        {state.status === 'loading' ? (
          <div
            style={{
              width: 276,
              height: 276,
              marginTop: 18,
              borderRadius: 20,
              border: '1px dashed var(--t-divider)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--t-text-muted)',
              fontSize: 12.5,
            }}
          >
            Generating…
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--t-text-secondary)',
                maxWidth: 320,
              }}
            >
              {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              style={{
                minHeight: 36,
                paddingLeft: 18,
                paddingRight: 18,
                borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text)',
                fontFamily: APP_FONT,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <div
              style={{
                marginTop: 18,
                padding: 18,
                borderRadius: 20,
                background: '#ffffff',
                boxShadow: '0 8px 28px rgba(12, 12, 12, 0.18)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no Next loader */}
              <img
                src={state.qrDataUrl}
                alt="o8 mobile pairing QR code"
                width={240}
                height={240}
                style={{ display: 'block', borderRadius: 8 }}
              />
            </div>

            <div
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: MONO_FONT,
                fontSize: 11.5,
                letterSpacing: '0.02em',
                color: 'var(--t-text-muted)',
              }}
            >
              <span style={{ color: 'var(--t-text-secondary)', fontWeight: 600 }}>{state.host}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>API {state.apiPort}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>WS {state.wsPort}</span>
            </div>
          </>
        ) : null}

        <button
          type="button"
          onClick={openConnections}
          style={{
            marginTop: 22,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            fontFamily: APP_FONT,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
        >
          Manage connections
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
