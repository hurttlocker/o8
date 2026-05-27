'use client';

import { memo, useMemo } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Minus, XCircle } from '../../lucide-shims';
import type { CheckBucket, PrCheck } from '../types';

interface ChecksTabProps {
  checks: PrCheck[];
}

function bucketFor(check: PrCheck): CheckBucket {
  const status = (check.status ?? '').toLowerCase();
  const conclusion = (check.conclusion ?? '').toLowerCase();
  if (!conclusion && (status === 'in_progress' || status === 'queued' || status === 'pending' || status === 'waiting')) {
    return 'running';
  }
  if (conclusion === 'success') return 'passed';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required' || conclusion === 'startup_failure') {
    return 'failing';
  }
  if (conclusion === 'skipped' || conclusion === 'cancelled') return 'skipped';
  if (conclusion === 'neutral' || conclusion === 'stale') return 'neutral';
  if (!conclusion) return 'running';
  return 'neutral';
}

const BUCKET_ORDER: CheckBucket[] = ['failing', 'running', 'passed', 'neutral', 'skipped'];

function bucketLabel(bucket: CheckBucket): string {
  if (bucket === 'failing') return 'Failing';
  if (bucket === 'running') return 'Running';
  if (bucket === 'passed') return 'Passed';
  if (bucket === 'neutral') return 'Neutral';
  return 'Skipped';
}

function bucketColor(bucket: CheckBucket): string {
  if (bucket === 'failing') return '#ef4444';
  if (bucket === 'passed') return '#16a34a';
  if (bucket === 'running') return '#f59e0b';
  return 'var(--t-text-muted)';
}

function CheckIcon({ bucket }: { bucket: CheckBucket }) {
  const color = bucketColor(bucket);
  if (bucket === 'failing') return <XCircle size={13} strokeWidth={2} style={{ color }} />;
  if (bucket === 'passed') return <CheckCircle2 size={13} strokeWidth={2} style={{ color }} />;
  if (bucket === 'running') return <Loader2 size={13} strokeWidth={2} style={{ color }} />;
  if (bucket === 'neutral') return <AlertCircle size={13} strokeWidth={2} style={{ color }} />;
  return <Minus size={13} strokeWidth={2} style={{ color }} />;
}

const CheckRow = memo(function CheckRow({ check, bucket }: { check: PrCheck; bucket: CheckBucket }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <CheckIcon bucket={bucket} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={check.name}>
        {check.name}
      </span>
      {bucket === 'failing' ? (
        <button
          type="button"
          onClick={() => {}}
          title="Coming soon"
          style={{
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 7,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-faint)',
            fontSize: 10,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            cursor: 'pointer',
            transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--t-hover)';
            e.currentTarget.style.color = 'var(--t-text)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--t-text-secondary, var(--t-text-muted))';
          }}
        >
          Debug
        </button>
      ) : null}
    </div>
  );
});

export const ChecksTab = memo(function ChecksTab({ checks }: ChecksTabProps) {
  const grouped = useMemo(() => {
    const map = new Map<CheckBucket, PrCheck[]>();
    for (const bucket of BUCKET_ORDER) map.set(bucket, []);
    for (const check of checks) {
      const bucket = bucketFor(check);
      map.get(bucket)!.push(check);
    }
    return map;
  }, [checks]);

  if (checks.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
        No checks reported for this PR.
      </div>
    );
  }

  return (
    <div>
      {BUCKET_ORDER.map((bucket) => {
        const items = grouped.get(bucket) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={bucket}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 9,
                paddingBottom: 9,
                paddingLeft: 14,
                paddingRight: 14,
                background: 'var(--t-bg-card)',
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 300,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: bucketColor(bucket),
                }}
              >
                {bucketLabel(bucket)}
              </span>
              <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)', fontVariantNumeric: 'tabular-nums' }}>
                {items.length}
              </span>
            </div>
            {items.map((check, index) => (
              <CheckRow key={`${check.name}-${index}`} check={check} bucket={bucket} />
            ))}
          </div>
        );
      })}
    </div>
  );
});
