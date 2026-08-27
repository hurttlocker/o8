'use client';

import { useEffect, useState } from 'react';

import { ActivityIcon } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

interface ShippedDarkFlagStatus {
  tomlKey: string;
  codeDefault: unknown;
  operatorValue: unknown;
  operatorValueSource: 'default' | 'file' | 'env';
  landedRelease: string | null;
  darkForReleases: number | null;
}

interface ShippedDarkAuditStatus {
  status: 'unverified' | 'current' | 'attention';
  checkedAt: string;
  currentRelease: string | null;
  thresholdReleases: number;
  checkedFlagCount: number;
  flags: ShippedDarkFlagStatus[];
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'unknown';
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return 'Not yet recorded';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ShippedDarkAuditSection() {
  const [audit, setAudit] = useState<ShippedDarkAuditStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/panel/status')
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { shippedDarkAudit?: ShippedDarkAuditStatus };
        if (!payload.shippedDarkAudit) throw new Error('Audit status missing');
        if (!cancelled) setAudit(payload.shippedDarkAudit);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Audit status unavailable');
      });
    return () => { cancelled = true; };
  }, []);

  const attentionCount = audit?.flags.filter((flag) => (
    flag.darkForReleases !== null
    && flag.darkForReleases >= audit.thresholdReleases
  )).length ?? 0;
  const subtitle = error
    ? `Status unavailable: ${error}`
    : !audit
      ? 'Reading the scheduled audit receipt'
      : audit.status === 'unverified'
        ? 'Waiting for the first scheduled receipt'
        : `${audit.checkedFlagCount} flags checked · ${audit.flags.length} remain dark · ${formatCheckedAt(audit.checkedAt)}`;

  return (
    <SettingsGroup
      header="Shipped feature audit"
      footnote={`Runs at app launch and every 24 hours. Attention begins after ${audit?.thresholdReleases ?? 3} shipped releases without promotion.`}
    >
      <SettingsRow
        icon={<ActivityIcon />}
        label="Default-off feature flags"
        subtitle={subtitle}
        accessory={audit?.status === 'attention'
          ? <ValuePill tone="destructive">{attentionCount} need attention</ValuePill>
          : audit?.status === 'current'
            ? <ValuePill tone="success">Current</ValuePill>
            : <ValuePill>{error ? 'Unavailable' : 'Checking…'}</ValuePill>}
        divider={Boolean(audit?.flags.length)}
      />
      {audit?.flags.map((flag, index) => {
        const age = flag.darkForReleases === null
          ? 'Age unknown'
          : `${flag.darkForReleases} release${flag.darkForReleases === 1 ? '' : 's'}`;
        return (
          <SettingsRow
            key={flag.tomlKey}
            label={flag.tomlKey}
            subtitle={`Default ${formatValue(flag.codeDefault)} · operator ${formatValue(flag.operatorValue)} (${flag.operatorValueSource}) · landed ${flag.landedRelease ?? 'unknown'}`}
            accessory={<ValuePill tone={flag.darkForReleases !== null && flag.darkForReleases >= audit.thresholdReleases ? 'destructive' : 'default'}>{age}</ValuePill>}
            divider={index < audit.flags.length - 1}
          />
        );
      })}
    </SettingsGroup>
  );
}
