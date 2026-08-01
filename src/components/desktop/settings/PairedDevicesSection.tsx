'use client';

/**
 * PairedDevicesSection — Settings → Mobile → Paired devices.
 *
 * Lists every device that enrolled a per-device token (GET /api/mobile/devices)
 * and lets the operator revoke any one (POST /api/mobile/devices/revoke). Revoke
 * drops the device from the HTTP gate immediately and its live WS within ~20s.
 * Destructive action uses an inline confirm strip (no overflow menus, per repo
 * rules). Empty until a phone enrolls (E2EE pairing), so it reads cleanly with
 * the flag off too.
 */

import { useCallback, useEffect, useState } from 'react';
import { APP_FONT_STACK, RamsButton } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

interface MobileDevice {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

function parseSqliteUtc(value: string | null): number | null {
  if (!value) return null;
  // sqlite datetime('now') is UTC, space-separated, no zone — normalize to ISO.
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function formatRelative(value: string | null): string {
  const ms = parseSqliteUtc(value);
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function DeviceRow({ device, onRevoke, busy, divider }: {
  device: MobileDevice;
  onRevoke: (id: string) => void;
  busy: boolean;
  divider: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const revoked = Boolean(device.revokedAt);
  const subtitle = revoked
    ? `Revoked ${formatRelative(device.revokedAt)} · paired ${formatRelative(device.createdAt)}`
    : `Paired ${formatRelative(device.createdAt)} · last seen ${formatRelative(device.lastSeenAt)}`;

  const accessory = revoked ? (
    <ValuePill tone="destructive">Revoked</ValuePill>
  ) : confirming ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontFamily: APP_FONT_STACK, fontSize: 11.5, fontWeight: 300, color: 'var(--t-text-secondary)' }}>
        Revoke this device?
      </span>
      <RamsButton variant="danger" busy={busy} onClick={() => onRevoke(device.id)}>
        Revoke
      </RamsButton>
      <RamsButton variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </RamsButton>
    </div>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <ValuePill tone="success">Active</ValuePill>
      <RamsButton variant="ghost" onClick={() => setConfirming(true)}>
        Revoke
      </RamsButton>
    </div>
  );

  return (
    <SettingsRow
      label={device.deviceLabel?.trim() || 'Unnamed device'}
      subtitle={subtitle}
      accessory={accessory}
      divider={divider}
    />
  );
}

export function PairedDevicesSection() {
  const [devices, setDevices] = useState<MobileDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/mobile/devices', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { devices?: MobileDevice[] };
      setDevices(Array.isArray(data.devices) ? data.devices : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
      setDevices([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = useCallback(async (deviceId: string) => {
    setRevokingId(deviceId);
    try {
      const res = await fetch('/api/mobile/devices/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevokingId(null);
    }
  }, [load]);

  const quiet = (text: string) => (
    <p style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 13,
      fontWeight: 300,
      color: 'var(--t-text-secondary)',
      lineHeight: 1.5,
      margin: 0,
    }}>
      {text}
    </p>
  );

  return (
    <SettingsGroup
      header="Paired devices"
      footnote={devices && devices.length > 0 ? 'Revoking a device cuts its access immediately — it must re-pair to return.' : undefined}
    >
      {devices === null ? (
        <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
          {quiet('Loading paired devices…')}
        </div>
      ) : devices.length === 0 ? (
        <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
          {quiet('No phones paired yet. Show the pairing QR above and scan it with the o8 app — each phone enrolls its own revocable key.')}
          {error ? (
            <p style={{ fontFamily: APP_FONT_STACK, fontSize: 11, fontWeight: 300, color: '#b23a28', marginTop: 8, marginBottom: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {devices.map((device, i) => (
            <DeviceRow
              key={device.id}
              device={device}
              onRevoke={revoke}
              busy={revokingId === device.id}
              divider={i < devices.length - 1}
            />
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14 }}>
            <RamsButton variant="ghost" onClick={() => void load()}>Refresh</RamsButton>
          </div>
          {error ? (
            <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12 }}>
              <p style={{ fontFamily: APP_FONT_STACK, fontSize: 11, fontWeight: 300, color: '#b23a28', margin: 0 }}>
                {error}
              </p>
            </div>
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}
