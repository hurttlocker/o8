'use client';

import { useEffect, useState } from 'react';

import { ActivityIcon } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

type ShippedDarkLifecycle = 'promotion-candidate' | 'deliberate-default-off' | 'promoted';

interface ShippedDarkFlagStatus {
  tomlKey: string;
  codeDefault: unknown;
  operatorValue: unknown;
  operatorValueSource: 'env' | 'file' | 'profile' | 'default';
  landedRelease: string | null;
  darkForReleases: number | null;
  lifecycle: ShippedDarkLifecycle;
  lifecycleRationale: string | null;
  needsAttention: boolean;
}

interface ShippedDarkAuditStatus {
  status: 'unverified' | 'current' | 'attention';
  checkedAt: string;
  currentRelease: string | null;
  thresholdReleases: number;
  checkedFlagCount: number;
  attentionFlagCount: number;
  flags: ShippedDarkFlagStatus[];
}

const LIFECYCLE_LABELS: Record<ShippedDarkLifecycle, string> = {
  'promotion-candidate': 'Awaiting promotion review',
  'deliberate-default-off': 'Off by design',
  promoted: 'Promoted',
};

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

  const attentionCount = audit?.attentionFlagCount ?? 0;
  // Only declared deliberate flags are "by design" — an under-threshold
  // promotion candidate is simply not overdue yet.
  const byDesignCount = audit?.flags.filter((flag) => (
    flag.lifecycle === 'deliberate-default-off'
  )).length ?? 0;
  const subtitle = error
    ? `Status unavailable: ${error}`
    : !audit
      ? 'Reading the scheduled audit receipt'
      : audit.status === 'unverified'
        ? 'Waiting for the first scheduled receipt'
        : `${audit.checkedFlagCount} flags checked · ${audit.flags.length} remain dark (${byDesignCount} by design) · ${formatCheckedAt(audit.checkedAt)}`;

  return (
    <SettingsGroup
      header="Shipped feature audit"
      footnote={`Runs at app launch and every 24 hours. Attention begins after ${audit?.thresholdReleases ?? 3} shipped releases for flags still awaiting a promotion decision; flags that are off by design stay listed without warning.`}
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
        const disposition = flag.lifecycleRationale
          ? `${LIFECYCLE_LABELS[flag.lifecycle]} — ${flag.lifecycleRationale}`
          : LIFECYCLE_LABELS[flag.lifecycle];
        return (
          <SettingsRow
            key={flag.tomlKey}
            label={flag.tomlKey}
            subtitle={`Default ${formatValue(flag.codeDefault)} · operator ${formatValue(flag.operatorValue)} (${flag.operatorValueSource}) · landed ${flag.landedRelease ?? 'unknown'} · ${age} · ${disposition}`}
            accessory={<ValuePill tone={flag.needsAttention ? 'destructive' : 'default'}>{flag.needsAttention ? age : LIFECYCLE_LABELS[flag.lifecycle]}</ValuePill>}
            divider={index < audit.flags.length - 1}
          />
        );
      })}
    </SettingsGroup>
  );
}
