import { demoFleet } from '@/lib/demo/fleet';

const criticalItems = demoFleet.events.filter((event) => event.severity !== 'info');
const pendingApprovals = demoFleet.agents.filter((agent) => agent.approvalStatus === 'pending');

export function MobileRemoteShell() {
  return (
    <div className="mobile-wrap">
      <header className="surface-card mobile-header">
        <div>
          <div className="eyebrow">Cortex IDE Remote</div>
          <h1>Phone-first operator surface</h1>
          <p className="muted">
            This is not pretending to be a full IDE. It is the fast remote layer for approvals, steering,
            alerts, and quick recall.
          </p>
        </div>
        <a href="/" className="inline-link">
          Back to desktop ↗
        </a>
      </header>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Alerts</span>
          <strong>{criticalItems.length}</strong>
          <p>Blocked runs and pairing gaps should be resolvable from the phone.</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Approvals</span>
          <strong>{pendingApprovals.length}</strong>
          <p>Quick yes / no / steer path instead of “open laptop now”.</p>
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Inbox</div>
            <h2>Operator actions</h2>
          </div>
          <span className="status-pill status-warning">live preview</span>
        </div>
        <div className="mobile-stack">
          {pendingApprovals.map((agent) => (
            <div key={agent.id} className="mobile-action-card">
              <div>
                <h3>{agent.name}</h3>
                <p>{agent.currentTask}</p>
              </div>
              <div className="tool-drawer-list tool-drawer-list-mobile">
                <button>Approve</button>
                <button>Deny</button>
                <button>Steer</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Context</div>
            <h2>Cortex quick recall</h2>
          </div>
        </div>
        <div className="mobile-memory-card">
          <div>
            <strong>Relevant memory</strong>
            <p className="muted">
              Pairing contract is still draft. Keep Remodex-derived bridge provider-agnostic and preserve
              local-first control service boundaries.
            </p>
          </div>
          <button className="button-primary">Open recall</button>
        </div>
      </section>
    </div>
  );
}
