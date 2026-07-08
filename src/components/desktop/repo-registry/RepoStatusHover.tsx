'use client';
/* eslint-disable react-hooks/set-state-in-effect -- data-fetch hooks follow the
   same fetch-then-setState pattern already used in useRepoCardModel; the
   stricter React 19 rule doesn't match how we scope fetches by hover-enable. */

import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  formatRelativeTime,
  resolveFloatingPanelPosition,
  shortenPath,
  type BranchAgent,
  type RepoRegistryEntry,
} from './shared';

// ─────────────────────────────────────────────────────────────────────
//  Raw single-stroke icons — Phosphor React components don't render in
//  the Tauri webview, so every icon is inlined from the defs/.
// ─────────────────────────────────────────────────────────────────────

function IconCommit({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="4" />
      <path d="M1.5 12h6" />
      <path d="M16.5 12H22.5" />
    </svg>
  );
}

function IconDiff({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 4v16" />
      <path d="M4 12h16" />
    </svg>
  );
}

function IconUpDown({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M8 4v16" />
      <path d="m4 8 4-4 4 4" />
      <path d="M16 20V4" />
      <path d="m12 16 4 4 4-4" />
    </svg>
  );
}

function IconChecks({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="m3 12 4 4 7-7" />
      <path d="m12 17 4 4 5-5" />
    </svg>
  );
}

function IconPullRequest({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M18 15.8v-5a2.4 2.4 0 0 0-2.4-2.4H12" />
      <path d="m14 10.2-2-1.8 2-1.8" />
    </svg>
  );
}

function IconAgents({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────

interface RepoStatusPayload {
  branch: string | null;
  lastCommit: {
    sha7: string;
    subject: string;
    timestamp: string | null;
    author: string;
  } | null;
  workingTree: {
    additions: number;
    deletions: number;
    fileCount: number;
  };
  upstream: {
    ahead: number;
    behind: number;
    upstreamRef: string | null;
  };
}

interface CiSnapshot {
  passed: number;
  failed: number;
  pending: number;
  total: number;
  latestRelativeTime: string | null;
  latestConclusion: 'success' | 'failure' | 'pending' | null;
}

interface PrSnapshot {
  open: number;
  awaitingReview: number;
}

interface AgentSnapshot {
  working: number;
  blocked: number;
  total: number;
}

export interface RepoStatusHoverProps {
  repo: RepoRegistryEntry;
  anchorRect: DOMRect | null;
  agents: BranchAgent[];
  githubSlug: string | null;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

// ─────────────────────────────────────────────────────────────────────
//  Data hooks — one per signal so a slow path doesn't block the rest.
// ─────────────────────────────────────────────────────────────────────

function useRepoStatus(localPath: string, enabled: boolean) {
  const [state, setState] = useState<RepoStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    const controller = new AbortController();
    fetch(`/api/panel/repo-status?path=${encodeURIComponent(localPath)}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        setState({
          branch: data.branch ?? null,
          lastCommit: data.lastCommit ?? null,
          workingTree: data.workingTree ?? { additions: 0, deletions: 0, fileCount: 0 },
          upstream: data.upstream ?? { ahead: 0, behind: 0, upstreamRef: null },
        });
      })
      .catch(() => {
        if (active) setState(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, localPath]);

  return { state, loading };
}

function useCiSnapshot(slug: string | null, enabled: boolean): { state: CiSnapshot | null; loading: boolean } {
  const [state, setState] = useState<CiSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !slug) {
      setState(null);
      return;
    }
    let active = true;
    setLoading(true);
    const controller = new AbortController();
    fetch(`/api/panel/ci?repo=${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { runs?: Array<{ conclusion?: string | null; status?: string | null; updatedAt?: string | null }> }) => {
        if (!active) return;
        const runs = data.runs ?? [];
        let passed = 0;
        let failed = 0;
        let pending = 0;
        for (const run of runs) {
          const concl = (run.conclusion ?? '').toLowerCase();
          const status = (run.status ?? '').toLowerCase();
          if (concl === 'success') passed += 1;
          else if (concl === 'failure' || concl === 'timed_out' || concl === 'cancelled') failed += 1;
          else if (status === 'in_progress' || status === 'queued' || status === 'pending' || !concl) pending += 1;
        }
        const latest = runs[0];
        const latestConclusion: CiSnapshot['latestConclusion'] = latest
          ? (latest.conclusion?.toLowerCase() === 'success' ? 'success'
            : latest.conclusion?.toLowerCase() === 'failure' ? 'failure'
            : 'pending')
          : null;
        setState({
          passed,
          failed,
          pending,
          total: runs.length,
          latestRelativeTime: latest?.updatedAt ? formatRelativeTime(latest.updatedAt) : null,
          latestConclusion,
        });
      })
      .catch(() => {
        if (active) setState(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, slug]);

  return { state, loading };
}

function usePrSnapshot(slug: string | null, enabled: boolean): { state: PrSnapshot | null; loading: boolean } {
  const [state, setState] = useState<PrSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !slug) {
      setState(null);
      return;
    }
    let active = true;
    setLoading(true);
    const controller = new AbortController();
    fetch(`/api/panel/prs?repo=${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { prs?: Array<{ state?: string; reviewDecision?: string | null }> }) => {
        if (!active) return;
        const prs = data.prs ?? [];
        const open = prs.filter((pr) => pr.state === 'OPEN').length;
        const awaitingReview = prs.filter((pr) => pr.state === 'OPEN' && (!pr.reviewDecision || pr.reviewDecision === 'REVIEW_REQUIRED')).length;
        setState({ open, awaitingReview });
      })
      .catch(() => {
        if (active) setState(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, slug]);

  return { state, loading };
}

function computeAgentSnapshot(agents: BranchAgent[]): AgentSnapshot {
  let working = 0;
  let blocked = 0;
  for (const agent of agents) {
    const status = agent.status;
    if (status === 'running' || status === 'reviewing') working += 1;
    else if (status === 'blocked' || status === 'failed' || status === 'awaiting_input' || status === 'awaiting_orchestrator' || status === 'awaiting_human') blocked += 1;
  }
  return { working, blocked, total: agents.length };
}

// ─────────────────────────────────────────────────────────────────────
//  Rendering primitives — strictly inline styles, theme tokens only.
// ─────────────────────────────────────────────────────────────────────

interface RowProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'attention' | 'danger';
  title?: string;
}

function StatusRow({ icon, label, value, tone = 'neutral', title }: RowProps) {
  const color = tone === 'danger'
    ? '#d28787'
    : tone === 'attention'
      ? '#d4a050'
      : 'var(--t-text-muted)';
  const valueColor = tone === 'danger' || tone === 'attention'
    ? color
    : 'var(--t-text)';
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 4,
        paddingBottom: 4,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          flexShrink: 0,
          color,
        }}
      >
        {icon}
      </div>
      <div
        style={{
          // Hurttlocker section label: 10/300/uppercase (was 10/600).
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--t-text-faint)',
          width: 88,
          flexShrink: 0,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          // Hurttlocker chrome value: 12/300/-0.1px (was 12.5/460).
          fontSize: 12,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          color: valueColor,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MutedValue({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--t-text-faint)' }}>{children}</span>;
}

function MonoShort({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', fontSize: 11.5, fontWeight: 500 }}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  RepoStatusHover — the full hover card
// ─────────────────────────────────────────────────────────────────────

function RepoStatusHoverBase({
  repo,
  anchorRect,
  agents,
  githubSlug,
  onMouseEnter,
  onMouseLeave,
}: RepoStatusHoverProps) {
  const cardWidth = 340;
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const status = useRepoStatus(repo.localPath, Boolean(anchorRect));
  const prs = usePrSnapshot(githubSlug, Boolean(anchorRect));
  const ci = useCiSnapshot(githubSlug, Boolean(anchorRect));
  const agentSnapshot = computeAgentSnapshot(agents);

  if (!mounted || !anchorRect || typeof document === 'undefined') return null;
  const position = resolveFloatingPanelPosition(anchorRect, cardWidth);

  const branch = status.state?.branch ?? repo.defaultBranch;
  const working = status.state?.workingTree ?? { additions: 0, deletions: 0, fileCount: 0 };
  const upstream = status.state?.upstream ?? { ahead: 0, behind: 0, upstreamRef: null };
  const commit = status.state?.lastCommit ?? null;

  // ── Row values ────────────────────────────────────────────────────
  const lastCommitValue = commit ? (
    <>
      <MonoShort>{commit.sha7}</MonoShort>
      <span style={{ padding: '0 6px', color: 'var(--t-text-faint)' }}>·</span>
      <span>{commit.subject || 'No subject'}</span>
      <span style={{ padding: '0 6px', color: 'var(--t-text-faint)' }}>·</span>
      <MutedValue>{formatRelativeTime(commit.timestamp)}</MutedValue>
    </>
  ) : status.loading ? <MutedValue>Loading…</MutedValue> : <MutedValue>No commits yet</MutedValue>;

  const workingTreeValue = (working.additions + working.deletions + working.fileCount) === 0
    ? <MutedValue>Clean</MutedValue>
    : (
      <>
        <span style={{ color: '#4ea672' }}>+{working.additions.toLocaleString()}</span>
        <span style={{ padding: '0 3px' }} />
        <span style={{ color: '#c97070' }}>−{working.deletions.toLocaleString()}</span>
        <MutedValue>
          {' '}in {working.fileCount} file{working.fileCount === 1 ? '' : 's'}
        </MutedValue>
      </>
    );

  const upstreamTone = upstream.behind > 0 ? 'attention' as const : 'neutral' as const;
  const upstreamValue = !upstream.upstreamRef
    ? <MutedValue>No upstream</MutedValue>
    : (upstream.ahead === 0 && upstream.behind === 0)
      ? <MutedValue>Up to date vs {upstream.upstreamRef}</MutedValue>
      : (
        <>
          <span style={{ color: upstream.ahead > 0 ? 'var(--t-text)' : 'var(--t-text-muted)' }}>↑{upstream.ahead}</span>
          <span style={{ padding: '0 6px', color: 'var(--t-text-faint)' }} />
          <span style={{ color: upstream.behind > 0 ? '#d4a050' : 'var(--t-text-muted)' }}>↓{upstream.behind}</span>
          <MutedValue> vs {upstream.upstreamRef}</MutedValue>
        </>
      );

  const ciTone = ci.state?.latestConclusion === 'failure' ? 'danger' as const
    : ci.state?.latestConclusion === 'pending' ? 'attention' as const
    : 'neutral' as const;
  const ciDotColor = ci.state?.latestConclusion === 'failure' ? '#d28787'
    : ci.state?.latestConclusion === 'pending' ? '#d4a050'
    : ci.state?.latestConclusion === 'success' ? '#4ea672'
    : 'var(--t-text-faint)';
  const ciValue = !githubSlug ? <MutedValue>No remote</MutedValue>
    : ci.loading && !ci.state ? <MutedValue>Loading…</MutedValue>
    : !ci.state || ci.state.total === 0 ? <MutedValue>No runs</MutedValue>
    : (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ciDotColor, flexShrink: 0 }} />
        <span>
          {ci.state.latestConclusion === 'failure' ? 'Failing'
            : ci.state.latestConclusion === 'pending' ? 'Running'
            : 'Passing'}
        </span>
        {ci.state.latestRelativeTime ? (
          <MutedValue>· {ci.state.latestRelativeTime}</MutedValue>
        ) : null}
      </span>
    );

  const prTone = (prs.state?.awaitingReview ?? 0) > 0 ? 'attention' as const : 'neutral' as const;
  const prValue = !githubSlug ? <MutedValue>No remote</MutedValue>
    : prs.loading && !prs.state ? <MutedValue>Loading…</MutedValue>
    : !prs.state ? <MutedValue>—</MutedValue>
    : prs.state.open === 0 ? <MutedValue>None open</MutedValue>
    : (
      <>
        <span>{prs.state.open} open</span>
        {prs.state.awaitingReview > 0 ? (
          <>
            <span style={{ padding: '0 6px', color: 'var(--t-text-faint)' }}>·</span>
            <span>{prs.state.awaitingReview} awaiting review</span>
          </>
        ) : null}
      </>
    );

  const agentsTone = agentSnapshot.blocked > 0 ? 'danger' as const
    : agentSnapshot.working > 0 ? 'attention' as const
    : 'neutral' as const;
  const agentsValue = agentSnapshot.total === 0 ? <MutedValue>None</MutedValue>
    : (
      <>
        {agentSnapshot.working > 0 ? (
          <span>{agentSnapshot.working} working</span>
        ) : null}
        {agentSnapshot.working > 0 && agentSnapshot.blocked > 0 ? (
          <span style={{ padding: '0 6px', color: 'var(--t-text-faint)' }}>·</span>
        ) : null}
        {agentSnapshot.blocked > 0 ? (
          <span>{agentSnapshot.blocked} blocked</span>
        ) : null}
        {agentSnapshot.working === 0 && agentSnapshot.blocked === 0 ? (
          <MutedValue>{agentSnapshot.total} session{agentSnapshot.total === 1 ? '' : 's'}</MutedValue>
        ) : null}
      </>
    );

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex: 10000,
        width: cardWidth,
        padding: '14px 16px 12px',
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
        color: 'var(--t-text)',
        pointerEvents: 'auto',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {/* Header — repo name + short path + branch. No pills. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        <div
          style={{
            // Hurttlocker row title: 13.5/300/-0.1px (was 14/600).
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {repo.name}
        </div>
        <div
          style={{
            // Hurttlocker meta: 9.5/260/-0.4 (was 11/normal).
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {shortenPath(repo.localPath)}
        </div>
        {branch ? (
          <div
            style={{
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {branch}
          </div>
        ) : null}
        {repo.readiness?.summary ? (
          <div
            style={{
              marginTop: 4,
              fontSize: 11.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.4,
              color: 'var(--t-text-secondary)',
            }}
          >
            {repo.readiness.summary}
          </div>
        ) : null}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--t-divider-subtle)', margin: '2px -16px 6px' }} />

      {/* Status rows — actionable signal, monochrome, flat density */}
      <StatusRow
        icon={<IconCommit size={13} />}
        label="Last commit"
        value={lastCommitValue}
        title={commit ? `${commit.author || 'Unknown author'} · ${commit.sha7}` : undefined}
      />
      <StatusRow
        icon={<IconDiff size={13} />}
        label="Working tree"
        value={workingTreeValue}
      />
      <StatusRow
        icon={<IconUpDown size={13} />}
        label="Upstream"
        value={upstreamValue}
        tone={upstreamTone}
      />
      <StatusRow
        icon={<IconChecks size={13} />}
        label="CI"
        value={ciValue}
        tone={ciTone}
      />
      <StatusRow
        icon={<IconPullRequest size={13} />}
        label="Pull requests"
        value={prValue}
        tone={prTone}
      />
      <StatusRow
        icon={<IconAgents size={13} />}
        label="Agents here"
        value={agentsValue}
        tone={agentsTone}
      />
    </div>,
    document.body,
  );
}

export const RepoStatusHover = memo(RepoStatusHoverBase);
