'use client';

import { useEffect, useMemo, useState } from 'react';
import type { EventItem, FleetSnapshot, SquadSummary, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import { openClawAdapterContract } from '@/lib/runtime/adapter';
import { SessionOperatorPanel } from '@/components/session-operator-panel';
import { WorkflowReviewPanel } from '@/components/workflow-review-panel';

const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact' });

const karpathyGuardrails = [
  'Primary object stays the agent / run / squad, not the file tree.',
  'Idle / blocked / reviewing visibility must stay obvious at a glance.',
  'Inline tools and supervision must feel native to live operator work.',
  'Usage, cost, and context pressure stay first-class, not hidden settings.',
  'Mobile remains a real remote-operator lane, not an afterthought.',
  'Topology only survives if it improves legibility faster than lists and boards.',
];

function statusClass(status: string) {
  return `status-pill status-${status}`;
}

function formatPercent(value?: number | null) {
  if (value == null) return '—';
  return `${value}%`;
}

function formatTokens(value?: number | null) {
  if (value == null) return '—';
  return compactNumber.format(value);
}

function formatIssueStack(snapshot?: WorkflowReviewSnapshot | null) {
  const issues = snapshot?.activeIssues ?? [];
  if (!issues.length) return 'Issue stack unavailable';
  return issues.map((issue) => `#${issue.number}`).join(' • ');
}

function pickPreferredAgent(snapshot: FleetSnapshot, currentId?: string) {
  if (currentId && snapshot.agents.some((agent) => agent.id === currentId)) {
    return currentId;
  }

  return snapshot.agents.find((agent) => agent.isCurrentSession)?.id ?? snapshot.agents[0]?.id ?? '';
}

function SquadCard({ squad }: { squad: SquadSummary }) {
  return (
    <div className="surface-card surface-card-tight">
      <div className="row space-between">
        <div>
          <div className="eyebrow">Squad</div>
          <h3>{squad.name}</h3>
        </div>
        <span className={statusClass(squad.status)}>{squad.status}</span>
      </div>
      <p className="muted">{squad.throughputLabel}</p>
      <div className="stat-grid compact">
        <div>
          <span>Sessions</span>
          <strong>{squad.liveSessions}</strong>
        </div>
        <div>
          <span>Alerts</span>
          <strong>{squad.alerts}</strong>
        </div>
        <div>
          <span>Blockers</span>
          <strong>{squad.blockers}</strong>
        </div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: EventItem }) {
  return (
    <div className={`event-row event-${event.severity}`}>
      <div className="event-time">{event.timestamp}</div>
      <div>
        <div className="event-title">{event.title}</div>
        <div className="event-detail">{event.detail}</div>
      </div>
    </div>
  );
}

export function CommandCenterShell({
  initialSnapshot,
  initialReview,
}: {
  initialSnapshot: FleetSnapshot;
  initialReview?: WorkflowReviewSnapshot | null;
}) {
  const [fleet, setFleet] = useState<FleetSnapshot>(initialSnapshot);
  const [review, setReview] = useState<WorkflowReviewSnapshot | null>(initialReview ?? null);
  const [selectedId, setSelectedId] = useState(() => pickPreferredAgent(initialSnapshot));
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId((currentId) => pickPreferredAgent(fleet, currentId));
  }, [fleet]);

  useEffect(() => {
    let active = true;

    async function refreshLiveFleet() {
      try {
        const response = await fetch('/api/openclaw/fleet', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const nextSnapshot = (await response.json()) as FleetSnapshot;
        if (!active) return;
        setFleet(nextSnapshot);
        setRefreshError(null);
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh live fleet');
      }
    }

    void refreshLiveFleet();
    const timer = window.setInterval(() => {
      void refreshLiveFleet();
    }, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function refreshReview() {
      try {
        const response = await fetch('/api/review/workspace', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const nextSnapshot = (await response.json()) as WorkflowReviewSnapshot;
        if (!active) return;
        setReview(nextSnapshot);
        setReviewError(null);
      } catch (error) {
        if (!active) return;
        setReviewError(error instanceof Error ? error.message : 'Unable to refresh workflow review');
      }
    }

    void refreshReview();
    const timer = window.setInterval(() => {
      void refreshReview();
    }, 45000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const selectedAgent = useMemo(
    () => fleet.agents.find((agent) => agent.id === selectedId) ?? fleet.agents[0],
    [fleet, selectedId],
  );

  const desktopInfo =
    typeof window !== 'undefined'
      ? (window as Window & {
          cortexDesktop?: { isDesktop: boolean; platform: string; version: string };
        }).cortexDesktop
      : undefined;

  const selectedSquad = fleet.squads.find((squad) => squad.id === selectedAgent?.squadId);
  const activeRuns = fleet.agents.filter((agent) => ['running', 'reviewing'].includes(agent.status)).length;
  const currentSession = fleet.agents.find((agent) => agent.isCurrentSession);
  const alertCount = fleet.agents.reduce((sum, agent) => sum + agent.alerts, 0);
  const gatewayLabel = fleet.meta.gatewayLabel ?? 'Gateway status unknown';
  const reviewPullRequest = review?.pullRequests?.[0];
  const reviewIssues = review?.activeIssues ?? [];
  const repoLaneLabel = reviewPullRequest
    ? `PR #${reviewPullRequest.number} • ${reviewPullRequest.headRefName}`
    : review?.branch
      ? `Branch • ${review.branch}`
      : 'Repo lane unavailable';
  const repoStateLabel = review?.dirty ? `${review.changedFiles.length} local changes` : 'working tree clean';
  const selectedEvents = selectedAgent
    ? fleet.events.filter((event) => event.agentId === selectedAgent.id)
    : [];
  const selectedArtifacts = selectedAgent
    ? fleet.artifacts.filter((artifact) => !artifact.agentId || artifact.agentId === selectedAgent.id)
    : fleet.artifacts;
  const visibleEvents = selectedEvents.length ? selectedEvents : fleet.events;
  const visibleArtifacts = selectedArtifacts.length ? selectedArtifacts : fleet.artifacts;

  const inspectorTokenLabel = selectedAgent?.tokenUsage?.totalTokens
    ? `${formatTokens(selectedAgent.tokenUsage.totalTokens)} used`
    : '—';

  return (
    <div className="page-wrap">
      <div className="announcement-bar">
        <span className={statusClass(fleet.meta.mode === 'live' ? 'healthy' : 'warning')}>
          {fleet.meta.mode === 'live' ? 'live OpenClaw' : 'demo fallback'}
        </span>
        <span className="muted">
          {fleet.meta.note}
          {refreshError ? ` Refresh warning: ${refreshError}.` : ''}
        </span>
      </div>

      <header className="surface-card hero-header">
        <div>
          <div className="brand-lockup">
            <div className="brand-orb">C</div>
            <div>
              <div className="eyebrow">Cortex IDE</div>
              <h1>Live OpenClaw command center</h1>
            </div>
          </div>
          <p className="hero-copy">
            First live bridge mode: mirror existing OpenClaw sessions into the control plane, starting
            with this Q ↔ Mister chat. New sessions belong behind explicit spawn actions, not silent UI
            side effects.
          </p>
        </div>
        <div className="command-strip">
          {reviewPullRequest ? (
            <a href={reviewPullRequest.url} target="_blank" rel="noreferrer">
              <button>{`PR #${reviewPullRequest.number}`}</button>
            </a>
          ) : null}
          <a href={`https://github.com/${review?.repoSlug ?? 'hurttlocker/cortex-ide'}/issues`} target="_blank" rel="noreferrer">
            <button>Issues</button>
          </a>
          <button type="button" onClick={() => window.location.reload()}>
            Refresh
          </button>
          <a href="/mobile" rel="noreferrer">
            <button className="button-primary">Mobile remote</button>
          </a>
        </div>
      </header>

      <main className="desktop-shell">
        <aside className="surface-card sidebar-column">
          <div className="section-head">
            <div>
              <div className="eyebrow">Live surfaces</div>
              <h2>Sessions</h2>
            </div>
            <span className={statusClass(fleet.meta.mode === 'live' ? 'running' : 'warning')}>
              {fleet.agents.length} visible
            </span>
          </div>

          <div className="sidebar-list">
            {fleet.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`agent-row ${agent.id === selectedAgent?.id ? 'agent-row-active' : ''}`}
                onClick={() => setSelectedId(agent.id)}
              >
                <div>
                  <div className="agent-row-name">{agent.name}</div>
                  <div className="agent-row-task">{agent.currentTask}</div>
                  <div className="eyebrow top-gap-small">{agent.surfaceLabel}</div>
                </div>
                <div className="agent-row-meta">
                  <span className={statusClass(agent.status)}>{agent.status}</span>
                  <span className="mono">{formatPercent(agent.context.usedPercent)} ctx</span>
                  {agent.isCurrentSession ? <span className={statusClass('healthy')}>mirrored now</span> : null}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="main-column">
          <div className="summary-grid">
            <div className="surface-card metric-card">
              <span>Active surfaces</span>
              <strong>{activeRuns}</strong>
              <p>Existing sessions are mirrored first; nothing here silently spawns a fresh run.</p>
            </div>
            <div className="surface-card metric-card">
              <span>Primary mirror</span>
              <strong>{currentSession?.name ?? 'No current session'}</strong>
              <p>{fleet.meta.primarySessionKey ?? 'No primary session key detected.'}</p>
            </div>
            <div className="surface-card metric-card">
              <span>Gateway</span>
              <strong>{fleet.meta.mode === 'live' ? 'reachable' : 'fallback'}</strong>
              <p>{gatewayLabel}</p>
            </div>
            <div className="surface-card metric-card">
              <span>Desktop shell</span>
              <strong>{desktopInfo?.isDesktop ? 'Attached' : 'Browser preview'}</strong>
              <p>
                {desktopInfo?.isDesktop
                  ? `Electron ${desktopInfo.version} on ${desktopInfo.platform}`
                  : 'Browser remains the fast dev surface while the desktop wrapper matures.'}
              </p>
            </div>
          </div>

          <div className="signal-grid">
            <div className="surface-card">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Repo truth</div>
                  <h2>Execution truth</h2>
                </div>
                <span className={statusClass(review?.dirty ? 'warning' : 'reviewing')}>
                  {review?.dirty ? 'local changes' : 'live repo lane'}
                </span>
              </div>
              <div className="signal-stack">
                <div className="signal-row">
                  <span>Repo</span>
                  <strong>{review?.repoSlug ?? 'hurttlocker/cortex-ide'}</strong>
                </div>
                <div className="signal-row">
                  <span>Branch</span>
                  <strong className="mono">{review?.branch ?? 'Loading…'}</strong>
                </div>
                <div className="signal-row">
                  <span>PR</span>
                  <strong>
                    {reviewPullRequest
                      ? `#${reviewPullRequest.number} — ${reviewPullRequest.title}`
                      : 'No open PR attached'}
                  </strong>
                </div>
                <div className="signal-row">
                  <span>Issue stack</span>
                  <strong>{formatIssueStack(review)}</strong>
                </div>
              </div>
              <ul className="bullet-list muted top-gap">
                <li>{repoLaneLabel}</li>
                <li>{repoStateLabel}</li>
                <li>
                  {review?.recentCommits?.[0]
                    ? `Latest commit • ${review.recentCommits[0]}`
                    : 'Latest commit unavailable'}
                </li>
                <li>
                  {reviewIssues.length
                    ? reviewIssues.map((issue) => `${issue.state.toLowerCase()} #${issue.number} ${issue.title}`).join(' • ')
                    : 'Issue linkage unavailable'}
                </li>
              </ul>
              {reviewError ? <p className="muted operator-note">{reviewError}</p> : null}
            </div>

            <div className="surface-card">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Karpathy guardrail</div>
                  <h2>Are we still on the right product?</h2>
                </div>
                <span className="status-pill status-healthy">checked</span>
              </div>
              <div className="guardrail-list">
                {karpathyGuardrails.map((item) => (
                  <div key={item} className="guardrail-item">
                    <div className="guardrail-dot" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="canvas-grid">
            <div className="surface-card surface-card-tall">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Overview</div>
                  <h2>Live OpenClaw inventory</h2>
                </div>
                <a href="/mobile" className="inline-link">
                  View mobile remote ↗
                </a>
              </div>
              <div className="topology-board">
                <div className="topology-panel">
                  <div className="eyebrow">Agent squads</div>
                  <div className="stack-grid">
                    {fleet.squads.map((squad) => (
                      <SquadCard key={squad.id} squad={squad} />
                    ))}
                  </div>
                </div>
                <div className="topology-panel surface-card inset-card">
                  <div className="eyebrow">Session model</div>
                  <h3>Mirror first, spawn explicitly</h3>
                  <p className="muted">
                    The first live bridge should show what OpenClaw is already doing, especially this
                    active session. Spawning belongs behind an explicit action so the UI never creates
                    ghost work or fake context.
                  </p>
                  <ul className="bullet-list muted">
                    <li>Primary mirror: {fleet.meta.primarySessionKey ?? 'unknown'}</li>
                    <li>Mode: {fleet.meta.mirrorMode}</li>
                    <li>Alerts across visible surfaces: {alertCount}</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="surface-card surface-card-tall">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Review rail</div>
                  <h2>{selectedAgent ? `${selectedAgent.name} evidence` : 'Live events + artifacts'}</h2>
                </div>
                <span className="status-pill status-reviewing">{visibleArtifacts.length} artifacts</span>
              </div>
              <p className="muted operator-note">
                {selectedEvents.length
                  ? 'This rail is filtered to the selected session first so transcript, events, and artifacts read as one bounded operator story.'
                  : 'No session-specific events were found, so this rail falls back to the broader fleet view.'}
              </p>
              <div className="event-stack">
                {visibleEvents.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </div>
              <div className="artifact-grid">
                {visibleArtifacts.map((artifact) => {
                  const chip = (
                    <div className="artifact-chip">
                      <span>{artifact.kind.replace('_', ' ')}</span>
                      <strong>{artifact.title}</strong>
                      {artifact.detail ? <p>{artifact.detail}</p> : null}
                      <em>{artifact.state}</em>
                    </div>
                  );

                  return artifact.href ? (
                    <a key={`${artifact.kind}:${artifact.title}`} href={artifact.href} target="_blank" rel="noreferrer">
                      {chip}
                    </a>
                  ) : (
                    <div key={`${artifact.kind}:${artifact.title}`}>{chip}</div>
                  );
                })}
              </div>
            </div>
          </div>

          <WorkflowReviewPanel initialSnapshot={review} />
        </section>

        {selectedAgent ? (
          <aside className="surface-card inspector-column">
            <div className="section-head">
              <div>
                <div className="eyebrow">Inspector</div>
                <h2>{selectedAgent.name}</h2>
              </div>
              <span className={statusClass(selectedAgent.status)}>{selectedAgent.status}</span>
            </div>

            <div className="inspector-block">
              <span>Current task</span>
              <strong>{selectedAgent.currentTask}</strong>
              {selectedAgent.isCurrentSession ? (
                <p className="muted">This is the same live session you and I are in right now.</p>
              ) : null}
            </div>

            <div className="stat-grid">
              <div>
                <span>Runtime</span>
                <strong>{selectedAgent.runtime}</strong>
              </div>
              <div>
                <span>Model</span>
                <strong>{selectedAgent.model}</strong>
              </div>
              <div>
                <span>Surface</span>
                <strong>{selectedAgent.surfaceLabel ?? selectedAgent.sessionKind ?? 'unknown'}</strong>
              </div>
              <div>
                <span>Session kind</span>
                <strong>{selectedAgent.sessionKind ?? 'unknown'}</strong>
              </div>
              <div>
                <span>Context</span>
                <strong>{formatPercent(selectedAgent.context.usedPercent)}</strong>
              </div>
              <div>
                <span>Tokens</span>
                <strong>{inspectorTokenLabel}</strong>
              </div>
            </div>

            <div className="inspector-block">
              <span>Session key</span>
              <strong className="mono">{selectedAgent.sessionKey}</strong>
              <p className="muted">Session id: {selectedAgent.sessionId ?? 'unknown'}</p>
            </div>

            <div className="inspector-block">
              <span>Agent workspace</span>
              <strong>{selectedSquad?.name ?? 'Unassigned'}</strong>
              <p className="muted">{selectedAgent.workspace}</p>
            </div>

            <div className="inset-card inspector-block">
              <div className="row space-between compact-row">
                <div>
                  <span>Adapter contract</span>
                  <strong>{openClawAdapterContract.displayName}</strong>
                </div>
                <span className="status-pill status-healthy">live bridge v1</span>
              </div>
              <ul className="bullet-list muted">
                <li>Current mode mirrors existing sessions, starting with this one.</li>
                <li>Steer + stop are now wired through the real OpenClaw gateway on explicit click only.</li>
                <li>Spawn remains an explicit future action, not an automatic side effect.</li>
                <li>Pause remains unsupported until runtime semantics are clean across providers.</li>
              </ul>
            </div>

            <SessionOperatorPanel agent={selectedAgent} />

            <div className="inset-card inspector-block">
              <span>Runtime trace</span>
              <pre className="terminal-preview">
                {`$ openclaw status --json
> source=${fleet.meta.sourceLabel}
> primary_session=${fleet.meta.primarySessionKey ?? 'unknown'}
> selected_session=${selectedAgent.sessionKey}
> percent_used=${formatPercent(selectedAgent.context.usedPercent)}
> tokens=${formatTokens(selectedAgent.tokenUsage?.totalTokens)}

$ openclaw gateway call chat.history --json --params '${JSON.stringify({
                  sessionKey: selectedAgent.sessionKey,
                  limit: 10,
                })}'
$ openclaw gateway call chat.send --json --params '${JSON.stringify({
                  sessionKey: selectedAgent.sessionKey,
                  message: '...',
                  idempotencyKey: '<uuid>',
                })}'
$ openclaw gateway call chat.abort --json --params '${JSON.stringify({
                  sessionKey: selectedAgent.sessionKey,
                })}'`}
              </pre>
            </div>
          </aside>
        ) : null}
      </main>
    </div>
  );
}
