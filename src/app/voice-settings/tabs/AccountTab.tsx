'use client';

import { useEffect, useState } from 'react';
import { AccountAuthorizationSync } from '@/lib/entitlement/AccountAuthorizationSync';
import { ICONS, TEXT_SECONDARY, ACCENT_LIGHT } from '../tokens';
import { SectionCard, SectionTitle, ControlRow, GhostButton, PageHeader } from '../primitives';

export default function AccountTab() {
  const [version, setVersion] = useState('');

  useEffect(() => {
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => { /* noop */ });
  }, []);

  return (
    <AccountAuthorizationSync>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <PageHeader icon={ICONS.user} title="Account" />

        <SectionCard>
          <SectionTitle icon={ICONS.gear}>Software</SectionTitle>
          <ControlRow label="Version" detail="o8 updates install automatically in the background.">
            <span style={{ fontSize: 13, color: TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' }}>{version ? `v${version}` : '-'}</span>
          </ControlRow>
          <ControlRow label="Release channel" detail="Signed builds from o8-run/o8.">
            <span style={{ fontSize: 13, color: ACCENT_LIGHT }}>Stable</span>
          </ControlRow>
          <div style={{ marginTop: 14 }}>
            <GhostButton label="Release notes" onClick={() => { window.open('https://github.com/o8-run/o8/releases', '_blank'); }} />
          </div>
        </SectionCard>
      </div>
    </AccountAuthorizationSync>
  );
}
