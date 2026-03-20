import { Suspense } from 'react';
import { CommandCenterShell } from '@/components/command-center-shell';
import { DesktopWebSocketProvider } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { createCommandCenterShellSnapshot, getCommandCenterBootstrap } from '@/lib/render/bootstrap';

export const dynamic = 'force-dynamic';

function CommandCenterRouteFallback() {
  const shell = createCommandCenterShellSnapshot();

  return (
    <div className="page-wrap">
      <div className="announcement-bar">
        <span className="status-pill status-warning">shell-only</span>
        <span className="status-pill status-warning">warming</span>
        <span className="muted">{shell.fleet.meta.note}</span>
      </div>
      <header className="surface-card hero-header">
        <div>
          <div className="brand-lockup">
            <div className="brand-orb">C</div>
            <div>
              <div className="eyebrow">Cortex IDE</div>
              <h1>Live runtime command center</h1>
            </div>
          </div>
          <p className="hero-copy">
            Shell is visible immediately. Live runtime, review, and browser truth will settle in after the first paint.
          </p>
        </div>
      </header>
      <main className="desktop-shell">
        <aside className="surface-card sidebar-column">
          <div className="section-head">
            <div>
              <div className="eyebrow">Live surfaces</div>
              <h2>Sessions warming</h2>
            </div>
            <span className="status-pill status-warning">warming</span>
          </div>
          <div className="remodex-skeleton-stack">
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user" />
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
          </div>
        </aside>
        <section className="main-column">
          <div className="summary-grid">
            <div className="surface-card metric-card">
              <span>Active surfaces</span>
              <strong>—</strong>
              <p>Waiting for live runtime discovery.</p>
            </div>
            <div className="surface-card metric-card">
              <span>Primary mirror</span>
              <strong>Warming</strong>
              <p>Bootstrap is still filling in.</p>
            </div>
            <div className="surface-card metric-card">
              <span>Gateway</span>
              <strong>Warming</strong>
              <p>Hot broker or fallback snapshot will land after paint.</p>
            </div>
            <div className="surface-card metric-card">
              <span>Desktop shell</span>
              <strong>Visible</strong>
              <p>Chrome can paint before discovery finishes.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

async function CommandCenterBootstrapView() {
  const bootstrap = await getCommandCenterBootstrap({ fresh: false, budgetMs: 0 });

  return (
    <>
      <div
        hidden
        data-cortex-bootstrap-marker="page"
        data-cortex-bootstrap-source={bootstrap.source}
        data-cortex-bootstrap-state={bootstrap.state}
        data-cortex-bootstrap-refreshed-at={bootstrap.refreshedAt ?? ''}
      />
      <CommandCenterShell
        initialSnapshot={bootstrap.snapshot.fleet}
        initialReview={bootstrap.snapshot.review}
        initialBrowserInventory={bootstrap.snapshot.browserInventory}
        initialAttachedBrowser={bootstrap.snapshot.attachedBrowser}
        initialReviewError={bootstrap.snapshot.reviewError}
        initialBrowserError={bootstrap.snapshot.browserError}
      />
    </>
  );
}

export default function HomePage() {
  return (
    <DesktopWebSocketProvider>
      <Suspense fallback={<CommandCenterRouteFallback />}>
        <CommandCenterBootstrapView />
      </Suspense>
    </DesktopWebSocketProvider>
  );
}
