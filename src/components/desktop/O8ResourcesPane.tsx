'use client';

/**
 * O8ResourcesPane — a per-session Activity Monitor for the O8 Panel.
 *
 * Polls /api/panel/resource-usage (~2.5s) and renders which agent sessions /
 * processes are consuming the most CPU and RAM right now, sorted by RAM. Real
 * numbers only — unresolved metrics render as an em-dash, never a fabricated
 * value. Modeled on O8ActivityPane's structure, theming, and header language.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ResourceRow {
  key: string;
  kind: 'session' | 'process';
  label: string;
  repo: string | null;
  runtime: string | null;
  pid: number | null;
  cpuPercent: number | null;
  memBytes: number | null;
}

interface ResourceUsageResult {
  sessions: ResourceRow[];
  processes: ResourceRow[];
  total: { cpuPercent: number; memBytes: number; ramTotalBytes: number };
  error?: string;
}

const POLL_MS = 2500;
const NUMERIC_FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

function formatCpu(cpu: number | null): string {
  if (cpu == null || !Number.isFinite(cpu)) return '—';
  return `${Math.round(cpu)}%`;
}

function ResourceRowView({ row, rowMax }: { row: ResourceRow; rowMax: number }) {
  const subtitleParts = [row.repo, row.runtime].filter((part): part is string => Boolean(part));
  if (row.pid != null) subtitleParts.push(`pid ${row.pid}`);
  const barPct = row.memBytes != null && rowMax > 0
    ? Math.max(2, Math.min(100, Math.round((row.memBytes / rowMax) * 100)))
    : 0;
  return (
    <div style={{
      paddingTop: 8,
      paddingRight: 14,
      paddingBottom: 8,
      paddingLeft: 14,
      borderBottom: '1px solid var(--t-divider-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13,
            fontWeight: 350,
            letterSpacing: '-0.1px',
            color: 'var(--t-text)',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {row.label}
          </div>
          {subtitleParts.length > 0 ? (
            <div style={{
              marginTop: 2,
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.2px',
              color: 'var(--t-text-faint)',
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {subtitleParts.join(' • ')}
            </div>
          ) : null}
        </div>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 2,
          flexShrink: 0,
          fontFamily: NUMERIC_FONT,
          fontVariantNumeric: 'tabular-nums',
        }}>
          <span style={{ fontSize: 12, fontWeight: 400, letterSpacing: '-0.2px', color: 'var(--t-text)' }}>
            {formatBytes(row.memBytes)}
          </span>
          <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-muted)' }}>
            {formatCpu(row.cpuPercent)} CPU
          </span>
        </div>
      </div>
      {/* Usage bar — width ∝ this row's RAM against the busiest row. */}
      <div style={{
        marginTop: 6,
        height: 3,
        borderRadius: 999,
        background: 'var(--t-input-bg)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${barPct}%`,
          height: '100%',
          borderRadius: 999,
          background: 'var(--t-text-secondary)',
          transition: 'width 400ms cubic-bezier(0.22, 1, 0.36, 1)',
        }} />
      </div>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      paddingTop: 10,
      paddingRight: 14,
      paddingBottom: 4,
      paddingLeft: 14,
      fontSize: 9,
      fontWeight: 300,
      color: 'var(--t-text-faint)',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>
      {text}
    </div>
  );
}

export const O8ResourcesPane = memo(function O8ResourcesPane({ active = true }: { active?: boolean }) {
  const [data, setData] = useState<ResourceUsageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/resource-usage', { cache: 'no-store' });
      const json = (await res.json()) as ResourceUsageResult;
      if (mountedRef.current) setData(json);
    } catch {
      // Keep the last good snapshot on a transient fetch failure.
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Poll only while visible — pause when the pane isn't the active tab.
  useEffect(() => {
    if (!active) return;
    void load();
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const sessions = data?.sessions ?? [];
  const processes = data?.processes ?? [];
  const rowMax = useMemo(() => {
    let max = 0;
    for (const row of [...sessions, ...processes]) {
      if (row.memBytes != null && row.memBytes > max) max = row.memBytes;
    }
    return max;
  }, [sessions, processes]);

  const isEmpty = sessions.length === 0 && processes.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header — title + host RAM / CPU totals */}
      <div style={{
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 14,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 400, letterSpacing: '-0.2px', color: 'var(--t-text)' }}>
            Resources
          </span>
          <span style={{
            fontSize: 10.5,
            fontWeight: 300,
            letterSpacing: '-0.2px',
            color: 'var(--t-text-muted)',
            fontFamily: NUMERIC_FONT,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {data
              ? `${formatBytes(data.total.memBytes)} / ${formatBytes(data.total.ramTotalBytes)} RAM · ${formatCpu(data.total.cpuPercent)} CPU`
              : '—'}
          </span>
        </div>
      </div>

      {/* Rows */}
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && !data ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.1px',
          }}>
            Reading process table…
          </div>
        ) : isEmpty ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            lineHeight: 1.45,
            letterSpacing: '-0.1px',
          }}>
            No active sessions.
          </div>
        ) : (
          <>
            {sessions.length > 0 ? (
              <>
                <SectionLabel text="Sessions" />
                {sessions.map((row) => (
                  <ResourceRowView key={row.key} row={row} rowMax={rowMax} />
                ))}
              </>
            ) : null}
            {processes.length > 0 ? (
              <>
                <SectionLabel text="Processes" />
                {processes.map((row) => (
                  <ResourceRowView key={row.key} row={row} rowMax={rowMax} />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});
