'use client';

/**
 * ConnectionsTab — Settings → Mobile.
 *
 * Mobile pairing and outbound relay controls. The QR code itself lives in the
 * full-screen MobilePairingView (a Canvas tab); the connect switch controls the
 * separate machine-scoped relay attach used by the future web surface.
 */

import { useCallback, useEffect, useState } from 'react';
import { OPEN_MOBILE_PAIRING_EVENT } from '@/lib/desktop/events';
import { Monitor, Smartphone } from '../lucide-shims';
import {
  APP_FONT_STACK,
  RamsButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { PairedDevicesSection } from './PairedDevicesSection';

type AttachSettingResponse = {
  ok: boolean;
  enabled?: boolean;
  locked?: boolean;
  error?: { message?: string };
};

export function ConnectionsTab() {
  const [connectEnabled, setConnectEnabled] = useState(false);
  const [connectLocked, setConnectLocked] = useState(false);
  const [connectLoading, setConnectLoading] = useState(true);
  const [connectSaving, setConnectSaving] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const showPairingQr = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_MOBILE_PAIRING_EVENT));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/panel/connect/attach', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json() as AttachSettingResponse;
        if (!response.ok || !data.ok || typeof data.enabled !== 'boolean') {
          throw new Error(data.error?.message ?? 'Could not read the connect setting.');
        }
        if (cancelled) return;
        setConnectEnabled(data.enabled);
        setConnectLocked(data.locked === true);
      })
      .catch((error) => {
        if (!cancelled) {
          setConnectError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setConnectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleConnect = useCallback(async (enabled: boolean) => {
    const previous = connectEnabled;
    setConnectEnabled(enabled);
    setConnectSaving(true);
    setConnectError(null);
    try {
      const response = await fetch('/api/panel/connect/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as AttachSettingResponse;
      if (!response.ok || !data.ok || typeof data.enabled !== 'boolean') {
        if (typeof data.enabled === 'boolean') setConnectEnabled(data.enabled);
        throw new Error(data.error?.message ?? 'Could not update the connect setting.');
      }
      setConnectEnabled(data.enabled);
      setConnectLocked(data.locked === true);
    } catch (error) {
      setConnectEnabled(previous);
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectSaving(false);
    }
  }, [connectEnabled]);

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="mobile"
        subtitle="Pair the o8 mobile app to approve, monitor, and steer your fleet from your phone."
      />

      <section>
        <SettingsGroup
          header="Remote access"
          footnote={connectError
            ?? (connectLocked
              ? 'This switch is controlled by O8_CONNECT_ATTACH.'
              : 'Off by default. Run o8 connect first, then enable this Mac when you want the future web control surface to reach it.')}
        >
          <SettingsRow
            icon={<Monitor size={14} />}
            label="Connect this Mac"
            subtitle="Keep an authenticated outbound connection to the o8 relay"
            checked={connectEnabled}
            onToggle={toggleConnect}
            disabled={connectLoading || connectSaving || connectLocked}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Pairing">
          <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
            <p style={{
              fontSize: 13,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              maxWidth: 560,
              margin: 0,
              marginBottom: 16,
            }}>
              o8 mobile connects directly to this Mac over your local network. Open the pairing
              code, then scan it with the o8 app — your phone and this Mac must be on the same
              Wi-Fi network.
            </p>
            <RamsButton onClick={showPairingQr} icon={<Smartphone size={14} />}>
              Show pairing QR
            </RamsButton>
          </div>
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <PairedDevicesSection />
      </section>
    </div>
  );
}
