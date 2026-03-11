'use client';

import { useMemo, useState } from 'react';
import { demoFleet } from '@/lib/demo/fleet';
import type { AgentSummary, EventItem, SquadSummary } from '@/lib/fleet/types';
import { openClawAdapterContract } from '@/lib/runtime/adapter';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function statusClass(status: string) {
  return `status-pill status-${status}`;
}

function formatTrend(value: number) {
  return `${value}%`;
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
          <span>Budget</span>
          <strong>{money.format(squad.budgetUsdToday)}</strong>
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

export function CommandCenterShell() {
  const [selectedId, setSelectedId] = useState(demoFleet.agents[0]?.id ?? '');
  const selectedAgent = useMemo(
    () => demoFleet.agents.find((agent) => agent.id === selectedId) ?? demoFleet.agents[0],
    [selectedId],
  );

  const selectedSquad = demoFleet.squads.find((squad) => squad.id === selectedAgent?.squadId);

  return (
    <div className="page-wrap">
      <div className="announcement-bar">
        <span>v0 execution is live.</span>
        <span className="muted">This shell is built to prove desktop + mobile productivity, not to win design awards first.</span>
      </div>

      <header className="surface-card hero-header">
        <div>
          <div className="brand-lockup">
            <div className="brand-orb">C</div>
            <div>
              <div className="eyebrow">Cortex IDE</div>
              <h1>Agent command center</h1>
            </div>
          </div>
          <p className="hero-copy">
            A bigger IDE for the agent era: fleet visibility, inline tools, runtime control, review,
            memory, and mobile supervision.
          </p>
        </div>
        <div className="command-strip">
          <button>Spawn</button>
          <button>Steer</button>
          <button>Pause fleet</button>
          <button>Review queue</button>
          <button className="button-primary">Mobile pairing</button>
        </div>
      </header>

      <main className="desktop-shell">
        <aside className="surface-card sidebar-column">
          <div className="section-head">
            <div>
              <div className="eyebrow">Fleet</div>
              <h2>Agents</h2>
            </div>
            <span className="status-pill status-running">{demoFleet.agents.length} online</span>
          </div>

          <div className="sidebar-list">
            {demoFleet.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`agent-row ${agent.id === selectedAgent.id ? 'agent-row-active' : ''}`}
                onClick={() => setSelectedId(agent.id)}
              >
                <div>
                  <div className="agent-row-name">{agent.name}</div>
                  <div className="agent-row-task">{agent.currentTask}</div>
                </div>
                <div className="agent-row-meta">
                  <span className={statusClass(agent.status)}>{agent.status}</span>
                  <span className="mono">{agent.context.usedPercent}% ctx</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="main-column">
          <div className="summary-grid">
            <div className="surface-card metric-card">
              <span>Active runs</span>
              <strong>3</strong>
              <p>1 blocked, 1 awaiting approval</p>
            </div>
            <div className="surface-card metric-card">
              <span>Pending approvals</span>
              <strong>2</strong>
              <p>1 mobile-worthy, 1 review-chain gate</p>
            </div>
            <div className="surface-card metric-card">
              <span>Spend today</span>
              <strong>{money.format(10.87)}</strong>
              <p>Budget visibility stays first-class.</p>
            </div>
            <div className="surface-card metric-card">
              <span>Context pressure</span>
              <strong>41%</strong>
              <p>Healthy enough to move, high enough to watch.</p>
            </div>
          </div>

          <div className="canvas-grid">
            <div className="surface-card surface-card-tall">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Overview</div>
                  <h2>Command canvas</h2>
                </div>
                <a href="/mobile" className="inline-link">
                  View mobile remote ↗
                </a>
              </div>
              <div className="topology-board">
                <div className="topology-panel">
                  <div className="eyebrow">Squads</div>
                  <div className="stack-grid">
                    {demoFleet.squads.map((squad) => (
                      <SquadCard key={squad.id} squad={squad} />
                    ))}
                  </div>
                </div>
                <div className="topology-panel surface-card inset-card">
                  <div className="eyebrow">Topology stance</div>
                  <h3>Legibility before gimmicks</h3>
                  <p className="muted">
                    Hoberman / spatial views stay optional. v1 earns the right to experiment only after the
                    core board, filters, inspector, and review loop are genuinely faster than terminals.
                  </p>
                  <ul className="bullet-list muted">
                    <li>Primary object: agent / run / squad</li>
                    <li>Primary controls: spawn, steer, pause, review</li>
                    <li>Primary visibility: idle, blocked, reviewing, cost, context</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="surface-card surface-card-tall">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Review rail</div>
                  <h2>Events + artifacts</h2>
                </div>
                <span className="status-pill status-reviewing">{demoFleet.artifacts.length} queued</span>
              </div>
              <div className="event-stack">
                {demoFleet.events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </div>
              <div className="artifact-grid">
                {demoFleet.artifacts.map((artifact) => (
                  <div key={artifact.title} className="artifact-chip">
                    <span>{artifact.kind.replace('_', ' ')}</span>
                    <strong>{artifact.title}</strong>
                    <em>{artifact.state}</em>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

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
              <span>Branch</span>
              <strong>{selectedAgent.branch}</strong>
            </div>
            <div>
              <span>Session</span>
              <strong className="mono">{selectedAgent.sessionKey}</strong>
            </div>
            <div>
              <span>Context</span>
              <strong>{formatTrend(selectedAgent.context.usedPercent)}</strong>
            </div>
            <div>
              <span>Cost</span>
              <strong>{money.format(selectedAgent.cost.sessionUsd)}</strong>
            </div>
          </div>

          <div className="inspector-block">
            <span>Squad</span>
            <strong>{selectedSquad?.name ?? 'Unassigned'}</strong>
            <p className="muted">{selectedAgent.workspace}</p>
          </div>

          <div className="inset-card inspector-block">
            <div className="row space-between compact-row">
              <div>
                <span>Adapter contract</span>
                <strong>{openClawAdapterContract.displayName}</strong>
              </div>
              <span className="status-pill status-healthy">draft MVP</span>
            </div>
            <ul className="bullet-list muted">
              <li>Spawn / attach / steer / stop mapped into one runtime contract</li>
              <li>Approvals, artifacts, and cost telemetry stay first-class</li>
              <li>Pause remains explicitly unsupported until runtime semantics are consistent</li>
            </ul>
          </div>

          <div className="inset-card inspector-block">
            <span>Inline tools</span>
            <div className="tool-drawer-list">
              <button>Terminal</button>
              <button>Diff</button>
              <button>Artifacts</button>
              <button>Memory</button>
            </div>
            <pre className="terminal-preview">$ cortex-ide open agent {selectedAgent.id}
&gt; status={selectedAgent.status}
&gt; approval={selectedAgent.approvalStatus}
&gt; alerts={selectedAgent.alerts}</pre>
          </div>
        </aside>
      </main>
    </div>
  );
}
