'use client';

/**
 * O8ResourcesPane — a per-session Activity Monitor for the O8 Panel.
 *
 * Polls /api/panel/resource-usage (~2.5s) and renders which agent sessions /
 * processes are consuming the most CPU and RAM right now, sorted by RAM. Real
 * numbers only — unresolved metrics render as an em-dash, never a fabricated
 * value. Each row has a hover-revealed inline Kill action with a two-step
 * confirm (POST → re-poll). Modeled on O8ActivityPane / O8InboxPane structure,
 * theming, and hover language (var(--t-hover)).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ResourceRow {
  key: string;
  kind: 'session' | 'process';
  label: string;
  repo: string | null;
  runtime: string | null;
  sessionKey: string | null;
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
const RIGHT_SLOT_WIDTH = 112;

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

function StopIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** Muted, monochrome runtime mini-label — no per-runtime colors (DESIGN.md). */
function RuntimeTag({ runtime }: { runtime: string | null }) {
  if (!runtime) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      flexShrink: 0,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 5,
      paddingRight: 5,
      borderRadius: 5,
      background: 'var(--t-input-bg)',
      color: 'var(--t-text-muted)',
      fontSize: 9,
      fontWeight: 350,
      letterSpacing: '0.02em',
      lineHeight: 1.3,
      fontFamily: 'var(--font-sans-system)',
      whiteSpace: 'nowrap',
    }}>
      {runtime}
    </span>
  );
}

function ResourceRowView({
  row,
  rowMax,
  onKill,
}: {
  row: ResourceRow;
  rowMax: number;
  onKill: (row: ResourceRow) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const killable = row.pid != null;
  const subtitleParts = [row.repo].filter((part): part is string => Boolean(part));
  if (row.pid != null) subtitleParts.push(`pid ${row.pid}`);
  const barPct = row.memBytes != null && rowMax > 0
    ? Math.max(2, Math.min(100, Math.round((row.memBytes / rowMax) * 100)))
    : 0;

  const showActions = killable && (hovered || confirming);

  const handleConfirmKill = useCallback(async () => {
    setBusy(true);
    try {
      await onKill(row);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [onKill, row]);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); if (!busy) setConfirming(false); }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
        background: hovered || confirming ? 'var(--t-hover)' : 'transparent',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {/* Label + meta + usage bar */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <RuntimeTag runtime={row.runtime} />
          <span style={{
            flex: 1,
            minWidth: 0,
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
          </span>
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

      {/* Right slot — fixed width so numeric columns line up. Shows RAM/CPU at
          rest; swaps to the inline Kill action + two-step confirm on hover. */}
      <div style={{
        width: RIGHT_SLOT_WIDTH,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        minHeight: 30,
      }}>
        {showActions ? (
          confirming ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-muted)' }}>
                {busy ? 'Stopping…' : 'Kill?'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={handleConfirmKill}
                title="Confirm kill"
                style={{
                  height: 20,
                  paddingLeft: 8,
                  paddingRight: 8,
                  borderRadius: 6,
                  border: '1px solid var(--t-danger-border)',
                  background: 'var(--t-danger-soft)',
                  color: 'var(--t-danger)',
                  fontSize: 10.5,
                  fontWeight: 400,
                  letterSpacing: '-0.1px',
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Kill
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                title="Cancel"
                style={{
                  height: 20,
                  paddingLeft: 8,
                  paddingRight: 8,
                  borderRadius: 6,
                  border: '1px solid var(--t-divider)',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 10.5,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              title="Stop this process"
              aria-label="Stop this process"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 22,
                paddingLeft: 8,
                paddingRight: 9,
                borderRadius: 6,
                border: '1px solid var(--t-divider)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
              }}
              onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-danger)'; event.currentTarget.style.borderColor = 'var(--t-danger-border)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; event.currentTarget.style.borderColor = 'var(--t-divider)'; }}
            >
              <StopIcon size={11} />
              Stop
            </button>
          )
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 2,
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
        )}
      </div>
    </div>
  );
}

function SectionLabel({ text, count }: { text: string; count: number }) {
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
      {text} · {count}
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

  const handleKill = useCallback(async (row: ResourceRow) => {
    if (row.pid == null) return;
    try {
      await fetch('/api/panel/resource-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: row.pid, key: row.key }),
      });
    } catch {
      // swallow — the re-poll below reflects the real post-kill state
    }
    await load();
  }, [load]);

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
                <SectionLabel text="Sessions" count={sessions.length} />
                {sessions.map((row) => (
                  <ResourceRowView key={row.key} row={row} rowMax={rowMax} onKill={handleKill} />
                ))}
              </>
            ) : null}
            {processes.length > 0 ? (
              <>
                <SectionLabel text="Processes" count={processes.length} />
                {processes.map((row) => (
                  <ResourceRowView key={row.key} row={row} rowMax={rowMax} onKill={handleKill} />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});
