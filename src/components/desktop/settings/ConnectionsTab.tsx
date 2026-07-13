'use client';

/**
 * ConnectionsTab — Settings → Mobile.
 *
 * Pairing entry point for the native o8 mobile app (epic #1074). The QR code
 * itself lives in the full-screen MobilePairingView (a Canvas tab) — this tab
 * links to it. The paired-device list, per-device revoke, and local-network
 * discovery toggle are deferred until backend device-tracking ships.
 */

import { useCallback } from 'react';
import { OPEN_MOBILE_PAIRING_EVENT } from '@/lib/desktop/events';
import { Smartphone } from '../lucide-shims';
import {
  APP_FONT_STACK,
  RamsButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup } from './grouped';
import { PairedDevicesSection } from './PairedDevicesSection';

export function ConnectionsTab() {
  const showPairingQr = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_MOBILE_PAIRING_EVENT));
  }, []);

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
