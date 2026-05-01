'use client';

import { useEffect, useState } from 'react';
import type { CliUsageSnapshot } from '@/lib/usage/cli-scrape';

const POLL_MS = 30_000;
const FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function formatTokens(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatReset(epochSeconds: number | null | undefined): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '';
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

interface BarProps {
  label: string;
  usedPercent: number | null;
  tokens: number | null;
  resetsAt: number | null;
  windowLabel: string;
}

function MicroBar({ label, usedPercent, tokens, resetsAt, windowLabel }: BarProps) {
  const pct = typeof usedPercent === 'number' ? Math.max(0, Math.min(100, usedPercent)) : null;
  const fillColor = pct !== null && pct >= 80
    ? '#dc2626'
    : pct !== null && pct >= 50
      ? '#f59e0b'
      : 'var(--t-brand-orange, #FF5A1F)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span
          style={{
            fontFamily: FONT,
            fontSize: 9,
            fontWeight: 560,
            letterSpacing: '0.06em',
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
          }}
        >
          [{label} {windowLabel}]
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t-text)', whiteSpace: 'nowrap' }}>
          {pct !== null ? `${pct.toFixed(0)}%` : formatTokens(tokens)}
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 3,
          width: '100%',
          background: 'var(--t-divider-subtle)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        {pct !== null ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${pct}%`,
              background: fillColor,
              transition: 'width 240ms ease-out',
            }}
          />
        ) : tokens && tokens > 0 ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: '100%',
              background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-text-faint) 100%)',
              opacity: 0.5,
            }}
          />
        ) : null}
      </div>
      {resetsAt ? (
        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--t-text-faint)' }}>
          resets in {formatReset(resetsAt)}
        </span>
      ) : (
        <span style={{ height: 11 }} />
      )}
    </div>
  );
}

export function RepoFocusUsageStrip() {
  const [snapshot, setSnapshot] = useState<CliUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/panel/cli-usage')
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data?.codex && data?.claude) {
            setSnapshot(data as CliUsageSnapshot);
            setError(null);
          } else {
            setError(data?.error || 'no usage data');
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        padding: '8px 14px 10px',
        borderTop: '1px solid var(--t-divider)',
        background: 'transparent',
      }}
    >
      <MicroBar
        label="CODEX"
        windowLabel="5h"
        usedPercent={snapshot?.codex.primary?.usedPercent ?? null}
        tokens={snapshot?.codex.primary?.tokens ?? null}
        resetsAt={snapshot?.codex.primary?.resetsAt ?? null}
      />
      <MicroBar
        label="CODEX"
        windowLabel="WK"
        usedPercent={snapshot?.codex.secondary?.usedPercent ?? null}
        tokens={snapshot?.codex.secondary?.tokens ?? null}
        resetsAt={snapshot?.codex.secondary?.resetsAt ?? null}
      />
      <MicroBar
        label="CLAUDE"
        windowLabel="5h"
        usedPercent={null}
        tokens={snapshot?.claude.primary?.tokens ?? null}
        resetsAt={snapshot?.claude.primary?.resetsAt ?? null}
      />
      <MicroBar
        label="CLAUDE"
        windowLabel="WK"
        usedPercent={null}
        tokens={snapshot?.claude.secondary?.tokens ?? null}
        resetsAt={null}
      />
      {error ? (
        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--t-text-faint)' }}>{error}</span>
      ) : null}
    </div>
  );
}
