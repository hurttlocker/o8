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
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
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
      <TabBreadcrumb tab="mobile" />
      <TabHeading
        title="mobile"
        subtitle="Pair the o8 mobile app to approve, monitor, and steer your fleet from your phone."
      />

      {/* 01 — PAIRING */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">PAIRING</SectionLabel>
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
      </section>

      {/* 02 — PAIRED DEVICES */}
      <section>
        <SectionLabel number="02">PAIRED DEVICES</SectionLabel>
        <PairedDevicesSection />
      </section>
    </div>
  );
}
