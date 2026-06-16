'use client';

/**
 * #796 — In-app visibility into the autonomous dogfood loop.
 *
 * The founder runs cron-style sub-agent dispatches in the background. Until
 * this section shipped, there was zero in-app visibility into what the loop
 * was doing — they had to ask Claude. Now Settings → Diagnostics shows:
 *
 *   - Cron last-fire age + next-fire age (read-only)
 *   - Open PR count
 *   - Active lane count + first 3 titles
 *   - Last 5 merges (collapsed by default)
 *
 * This is a READER. We never create or mutate `~/.o8/loop-cron-state.json`.
 *
 * Data sources (graceful when any is missing):
 *   - `/api/panel/loop-status` → cron state
 *   - `/api/lanes?active=true` → active lanes
 *   - `/api/panel/prs` → open PR count
 *   - `/api/panel/git/log?limit=5` → recent merges
 *
 * Cron state file schema (`~/.o8/loop-cron-state.json`, optional):
 *   {
 *     "jobId": "string",            // unique per scheduled job
 *     "cronExpression": "string",   // e.g. "0,20,40 * * * *"
 *     "lastFiredAt": "ISO 8601",    // most recent tick start
 *     "nextFireAt":  "ISO 8601",    // wall-clock of upcoming tick
 *     "prompt":      "string"       // first ~120 chars shown verbatim
 *   }
 *
 * If the file is absent the section renders "No active loop" gracefully —
 * no errors, no busy indicators, nothing scary in the empty state.
 *
 * Design rules followed:
 *   - Inline styles only / palette tokens only / Phosphor SVG only
 *   - system UI for chrome, MONO for hashes + counts
 *   - Issues-style rows: dot + uppercase mono label + value + hint
 *   - 800-line ceiling (this file lives well under it)
 */

import { useEffect, useState } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  SectionLabel,
} from './shared';

// ── Types ──

interface CronStateResponse {
  ok: boolean;
  active: boolean;
  jobId?: string | null;
  cronExpression?: string | null;
  lastFiredAt?: string | null;
  nextFireAt?: string | null;
  prompt?: string | null;
  note?: string;
}

interface LaneSummary {
  id: string;
  label: string;
  status: string;
}

interface RecentCommit {
  hash: string;
  title: string;
  ageMs: number;
}

interface LoopStatusData {
  cron: CronStateResponse | null;
  lanes: LaneSummary[];
  openPrCount: number;
  recentCommits: RecentCommit[];
}

// ── Helpers ──

function formatAge(ms: number | null | undefined, opts?: { future?: boolean }): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const abs = Math.max(0, Math.abs(ms));
  const seconds = Math.floor(abs / 1000);
  if (seconds < 60) return opts?.future ? `in ${seconds}s` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return opts?.future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return opts?.future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return opts?.future ? `in ${days}d` : `${days}d ago`;
}

function timestampDelta(iso: string | null | undefined, mode: 'past' | 'future'): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  return mode === 'past' ? now - t : t - now;
}

function shortHash(hash: string) {
  return hash.length >= 7 ? hash.slice(0, 7) : hash;
}

// ── Component ──

export function LoopStatusSection({ sectionNumber }: { sectionNumber: string }) {
  const [data, setData] = useState<LoopStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMerges, setShowMerges] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cron, lanes, prs, gitLog] = await Promise.all([
          fetch('/api/panel/loop-status', { cache: 'no-store' })
            .then(async (res) => res.ok ? (await res.json()) as CronStateResponse : null)
            .catch(() => null),
          fetch('/api/lanes?active=true', { cache: 'no-store' })
            .then(async (res) => res.ok ? (await res.json()) as { lanes?: LaneSummary[] } : null)
            .catch(() => null),
          fetch('/api/panel/prs', { cache: 'no-store' })
            .then(async (res) => res.ok ? (await res.json()) as { prs?: Array<{ state?: string }> } : null)
            .catch(() => null),
          fetch('/api/panel/git/log?limit=5', { cache: 'no-store' })
            .then(async (res) => res.ok ? (await res.json()) as { commits?: RecentCommit[] } : null)
            .catch(() => null),
        ]);

        if (cancelled) return;

        const openPrs = (prs?.prs ?? []).filter(
          (pr) => !pr.state || String(pr.state).toUpperCase() === 'OPEN',
        );

        setData({
          cron: cron ?? null,
          lanes: (lanes?.lanes ?? []).map((lane) => ({
            id: lane.id,
            label: lane.label,
            status: lane.status,
          })),
          openPrCount: openPrs.length,
          recentCommits: gitLog?.commits ?? [],
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const cron = data?.cron ?? null;
  const isActive = !!cron?.active;
  const lastFiredMs = timestampDelta(cron?.lastFiredAt ?? null, 'past');
  const nextFireMs = timestampDelta(cron?.nextFireAt ?? null, 'future');
  const lanes = data?.lanes ?? [];
  const openPrCount = data?.openPrCount ?? 0;
  const commits = data?.recentCommits ?? [];

  return (
    <section style={{ marginTop: 32 }}>
      <SectionLabel number={sectionNumber}>LOOP STATUS</SectionLabel>

      {loading && !data ? (
        <div style={{
          paddingTop: 14,
          paddingBottom: 14,
          fontFamily: APP_FONT_STACK,
          fontSize: 13,
          color: RAMS_INK_QUIET,
          lineHeight: 1.55,
        }}>
          Loading…
        </div>
      ) : null}

      {!loading && !isActive ? (
        <NoActiveLoop
          openPrCount={openPrCount}
          laneCount={lanes.length}
          commits={commits}
          showMerges={showMerges}
          onToggleMerges={() => setShowMerges((v) => !v)}
        />
      ) : null}

      {!loading && isActive ? (
        <ActiveLoopRows
          cron={cron}
          lastFiredMs={lastFiredMs}
          nextFireMs={nextFireMs}
          lanes={lanes}
          openPrCount={openPrCount}
          commits={commits}
          showMerges={showMerges}
          onToggleMerges={() => setShowMerges((v) => !v)}
        />
      ) : null}

      <div style={{
        marginTop: 16,
        fontFamily: APP_FONT_STACK,
        fontSize: 12,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.55,
      }}>
        Read-only. Loop is armed and disarmed via the cron tooling — this
        section never writes{' '}
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>
          ~/.o8/loop-cron-state.json
        </span>.
      </div>
    </section>
  );
}

// ── Sub-views ──

function NoActiveLoop({
  openPrCount,
  laneCount,
  commits,
  showMerges,
  onToggleMerges,
}: {
  openPrCount: number;
  laneCount: number;
  commits: RecentCommit[];
  showMerges: boolean;
  onToggleMerges: () => void;
}) {
  return (
    <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
      <Row
        dot={RAMS_INK_QUIET}
        label="Cron"
        value="No active loop"
        hint="No state file found"
      />
      <Row
        dot={RAMS_INK_QUIET}
        label="Open PRs"
        value={String(openPrCount)}
      />
      <Row
        dot={RAMS_INK_QUIET}
        label="Active lanes"
        value={String(laneCount)}
      />
      <DiscloseRow
        label="Recent merges"
        value={`Last ${commits.length}`}
        hint={commits.length === 0 ? 'No commits' : undefined}
        open={showMerges}
        onToggle={onToggleMerges}
        commits={commits}
      />
    </div>
  );
}

function ActiveLoopRows({
  cron,
  lastFiredMs,
  nextFireMs,
  lanes,
  openPrCount,
  commits,
  showMerges,
  onToggleMerges,
}: {
  cron: CronStateResponse | null;
  lastFiredMs: number | null;
  nextFireMs: number | null;
  lanes: LaneSummary[];
  openPrCount: number;
  commits: RecentCommit[];
  showMerges: boolean;
  onToggleMerges: () => void;
}) {
  const cronExpr = cron?.cronExpression ?? null;
  const cronValueParts: string[] = [];
  if (cronExpr) cronValueParts.push(cronExpr);
  cronValueParts.push(
    lastFiredMs !== null ? `last fired ${formatAge(lastFiredMs)}` : 'never fired',
  );
  if (nextFireMs !== null) {
    cronValueParts.push(`next ${formatAge(nextFireMs, { future: true })}`);
  }

  const firstThreeLanes = lanes.slice(0, 3);
  const laneTitles = firstThreeLanes.map((lane) => lane.label).filter(Boolean).join(' · ');

  return (
    <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
      <Row
        dot={RAMS_ACCENT}
        label="Cron"
        value={cronValueParts.join(' · ')}
        hint={cron?.jobId ?? undefined}
      />
      {cron?.prompt ? (
        <Row
          dot={RAMS_INK_QUIET}
          label="Prompt"
          value={truncatePrompt(cron.prompt)}
          mono={false}
        />
      ) : null}
      <Row
        dot={RAMS_INK_QUIET}
        label="Open PRs"
        value={String(openPrCount)}
      />
      <Row
        dot={lanes.length > 0 ? RAMS_ACCENT : RAMS_INK_QUIET}
        label="Active lanes"
        value={String(lanes.length)}
        hint={laneTitles || undefined}
      />
      <DiscloseRow
        label="Recent merges"
        value={`Last ${commits.length}`}
        hint={commits.length === 0 ? 'No commits' : undefined}
        open={showMerges}
        onToggle={onToggleMerges}
        commits={commits}
      />
    </div>
  );
}

function truncatePrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}…`;
}

// ── Row primitives — Issues-style ──

function Row({
  dot,
  label,
  value,
  hint,
  mono = true,
}: {
  dot: string;
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: dot,
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        minWidth: 180,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: mono ? MONO_FONT_STACK : APP_FONT_STACK,
        letterSpacing: mono ? '0.02em' : '-0.005em',
      }}>
        {value}
      </span>
      {hint ? (
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: '0.04em',
          color: 'var(--t-text-secondary)',
          textAlign: 'right',
          maxWidth: 320,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function DiscloseRow({
  label,
  value,
  hint,
  open,
  onToggle,
  commits,
}: {
  label: string;
  value: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  commits: RecentCommit[];
}) {
  const interactive = commits.length > 0;
  return (
    <div>
      <button
        type="button"
        onClick={interactive ? onToggle : undefined}
        disabled={!interactive}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          width: '100%',
          paddingTop: 12,
          paddingBottom: 12,
          borderTop: 'none',
          borderLeft: 'none',
          borderRight: 'none',
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          background: 'transparent',
          cursor: interactive ? 'pointer' : 'default',
          textAlign: 'left',
          minHeight: 44,
        }}
      >
        <span style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: RAMS_INK_QUIET,
          flexShrink: 0,
        }} />
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          color: RAMS_INK_QUIET,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          minWidth: 180,
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 13,
          fontWeight: 400,
          color: 'var(--t-text)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: APP_FONT_STACK,
          letterSpacing: '-0.005em',
        }}>
          {value}
        </span>
        {hint ? (
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '-0.005em',
            color: 'var(--t-text-secondary)',
            marginRight: 6,
          }}>
            {hint}
          </span>
        ) : null}
        {interactive ? (
          <Caret rotated={open} />
        ) : null}
      </button>

      {open && commits.length > 0 ? (
        <div style={{
          paddingTop: 6,
          paddingBottom: 12,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        }}>
          {commits.map((commit) => (
            <CommitRow key={commit.hash} commit={commit} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommitRow({ commit }: { commit: RecentCommit }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 14,
      paddingTop: 6,
      paddingBottom: 6,
      paddingLeft: 200,
    }}>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.04em',
        color: RAMS_INK_QUIET,
        minWidth: 64,
      }}>
        {shortHash(commit.hash)}
      </span>
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        letterSpacing: '-0.005em',
      }}>
        {commit.title}
      </span>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.04em',
        color: 'var(--t-text-secondary)',
        flexShrink: 0,
      }}>
        {formatAge(commit.ageMs)}
      </span>
    </div>
  );
}

function Caret({ rotated }: { rotated?: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{
        display: 'block',
        flexShrink: 0,
        color: RAMS_INK_QUIET,
        transition: 'transform 200ms',
        transform: rotated ? 'rotate(180deg)' : 'rotate(0)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
