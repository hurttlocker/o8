'use client';

/**
 * Account tab — plan + software. Plan reads o8's entitlement
 * (`/api/panel/entitlement`, loopback-gated, so the standalone window reaches it
 * same-origin). Software shows the running version. o8's full billing lives in
 * the main app's Plan & Billing — this is the voice-window summary.
 */
import { useEffect, useState } from 'react';
import { ICONS, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, ACCENT_LIGHT, OK_GREEN, SECTION_BG, SECTION_BORDER } from '../tokens';
import { SectionCard, SectionTitle, ControlRow, GhostButton, AccentButton, PageHeader } from '../primitives';

type Plan = 'free' | 'pro' | 'team' | null;

export default function AccountTab() {
  const [plan, setPlan] = useState<Plan>(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    fetch('/api/panel/entitlement', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.plan === 'string') setPlan(d.plan as Plan); })
      .catch(() => { /* noop */ });
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => { /* noop */ });
  }, []);

  const isPro = plan === 'pro' || plan === 'team';
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.user} title="Account" />

      <SectionCard>
        <SectionTitle icon={ICONS.user}>Plan</SectionTitle>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px', marginTop: 8,
          borderRadius: 14, border: `1px solid ${SECTION_BORDER}`, background: SECTION_BG,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.01em', color: TEXT_PRIMARY }}>{planLabel}</span>
              {isPro ? (
                <span style={{
                  fontSize: 9, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase',
                  padding: '2px 8px', borderRadius: 999, color: OK_GREEN,
                  border: '1px solid rgba(52,211,153,0.4)', background: 'rgba(52,211,153,0.12)',
                }}>Active</span>
              ) : null}
            </div>
            <div style={{ fontSize: 12.5, color: TEXT_TERTIARY, marginTop: 6, lineHeight: 1.45 }}>
              {isPro ? 'Pro features unlocked across o8.' : 'Voice, dictation, and history are free forever.'}
            </div>
          </div>
          {!isPro ? <AccentButton label="Upgrade" onClick={() => { window.open('https://o8.run/pricing', '_blank'); }} /> : null}
        </div>
        <p style={{ fontSize: 12, color: TEXT_TERTIARY, lineHeight: 1.5, marginTop: 14, marginBottom: 0, maxWidth: 460 }}>
          Manage billing, seats, and license keys in the main app → Settings → Plan &amp; Billing.
        </p>
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.gear}>Software</SectionTitle>
        <ControlRow label="Version" detail="o8 updates install automatically in the background.">
          <span style={{ fontSize: 13, color: TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' }}>{version ? `v${version}` : '—'}</span>
        </ControlRow>
        <ControlRow label="Release channel" detail="Signed builds from hurttlocker/o8.">
          <span style={{ fontSize: 13, color: ACCENT_LIGHT }}>Stable</span>
        </ControlRow>
        <div style={{ marginTop: 14 }}>
          <GhostButton label="Release notes" onClick={() => { window.open('https://github.com/hurttlocker/o8/releases', '_blank'); }} />
        </div>
      </SectionCard>
    </div>
  );
}
