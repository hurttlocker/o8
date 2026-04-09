'use client';

import dynamic from 'next/dynamic';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  BrowserAttachmentSummary,
  BrowserInventorySnapshot,
  BrowserSurfaceSummary,
} from '@/lib/browser/types';
import type { CommandCenterSnapshot } from '@/lib/command-center/snapshot';
import type { EventItem, FleetSnapshot, SquadSummary, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import { ContextUsageRing } from '@/components/ContextUsageRing';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import { shouldRetainCurrentCommandCenterSnapshot } from '@/lib/render/client-merge';
import { RealtimeEntityStore } from '@/lib/realtime/store';
import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import { formatTokens } from '@/lib/util/format-tokens';

const WorkflowReviewPanel = dynamic(
  () => import('@/components/workflow-review-panel').then((module) => module.WorkflowReviewPanel),
  {
    ssr: false,
    loading: () => (
      <div className="surface-card surface-card-tall">
        <div className="section-head">
          <div>
            <div className="eyebrow">Review rail</div>
            <h2>Loading review surface…</h2>
          </div>
          <span className="status-pill status-warning">warming</span>
        </div>
        <div className="remodex-skeleton-stack">
          <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
          <div className="remodex-skeleton-bubble remodex-skeleton-user" />
          <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
        </div>
      </div>
    ),
  },
);

const SessionOperatorPanel = dynamic(
  () => import('@/components/session-operator-panel').then((module) => module.SessionOperatorPanel),
  {
    ssr: false,
    loading: () => (
      <aside className="surface-card inspector-column">
        <div className="section-head">
          <div>
            <div className="eyebrow">Inspector</div>
            <h2>Loading operator panel…</h2>
          </div>
          <span className="status-pill status-warning">warming</span>
        </div>
        <div className="remodex-skeleton-stack">
          <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
          <div className="remodex-skeleton-bubble remodex-skeleton-user" />
          <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
        </div>
      </aside>
    ),
  },
);

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

function formatTokenUsage(value?: number | null) {
  if (value == null) return '—';
  return formatTokens(value);
}

function formatIssueStack(snapshot?: WorkflowReviewSnapshot | null) {
  const issues = snapshot?.activeIssues ?? [];
  if (!issues.length) return 'Issue stack unavailable';
  return issues.map((issue) => `#${issue.number}`).join(' • ');
}

function browserSurfaceLabel(surface?: BrowserSurfaceSummary | null) {
  if (!surface) return 'No browser lane attached';
  return surface.title ?? surface.url ?? `${surface.provider} browser lane`;
}

function browserProviderHint(surface: BrowserSurfaceSummary) {
  const bits = [
    surface.browserName,
    surface.attachUrl ? 'attach-ready' : null,
    surface.capabilities.persistentProfile ? 'persistent profile' : null,
  ].filter(Boolean);
  return bits.join(' • ');
}

function browserCapabilityHint(surface: BrowserSurfaceSummary) {
  const bits = [
    surface.attachUrl ? 'attach-ready' : 'discovered',
    surface.capabilities.inspectDom ? 'inspect' : null,
    surface.capabilities.screenshots ? 'screenshots' : null,
    surface.capabilities.persistentProfile ? 'persistent' : null,
  ].filter(Boolean);
  return bits.join(' • ');
}

function pickPreferredBrowserSurface(snapshot: BrowserInventorySnapshot, currentId?: string) {
  if (currentId && snapshot.surfaces.some((surface) => surface.id === currentId)) {
    return currentId;
  }
  return snapshot.surfaces[0]?.id ?? '';
}

function pickPreferredAgent(snapshot: FleetSnapshot, currentId?: string) {
  if (currentId && snapshot.agents.some((agent) => agent.id === currentId)) {
    return currentId;
  }

  return snapshot.agents.find((agent) => agent.isCurrentSession)?.id ?? snapshot.agents[0]?.id ?? '';
}

function deriveRealtimeHealth(
  fleet: FleetSnapshot,
  reviewError?: string | null,
  browserError?: string | null,
) {
  if (fleet.meta.mode !== 'live') return 'degraded' as const;
  if (reviewError || browserError || fleet.meta.gatewayFreshness === 'stale') return 'stale' as const;
  if (fleet.meta.gatewayFreshness === 'warming' || fleet.meta.observablePending) return 'warming' as const;
  return 'live' as const;
}

function createMutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deriveConnectionHealthByChannel(
  fleet: FleetSnapshot,
  reviewError?: string | null,
  browserError?: string | null,
) {
  const runtime = {
    state: deriveRealtimeHealth(fleet, reviewError, browserError),
    reason: fleet.meta.note ?? fleet.meta.gatewayLabel,
  } as const;
  return {
    runtime,
    review: reviewError
      ? { state: 'stale' as const, reason: reviewError }
      : runtime,
    browser: browserError
      ? { state: 'stale' as const, reason: browserError }
      : runtime,
  };
}

interface CommandCenterBootstrapResponse {
  snapshot: CommandCenterSnapshot;
  source: 'hot-broker' | 'degraded' | 'shell-only';
  state: 'live' | 'warming' | 'stale' | 'degraded';
  note: string;
  refreshedAt?: number | null;
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

const BrowserDiscoveryCard = memo(function BrowserDiscoveryCard({
  browserInventory,
  browserError,
  selectedExternalBrowserSurface,
  setSelectedExternalBrowserId,
}: {
  browserInventory: BrowserInventorySnapshot;
  browserError: string | null;
  selectedExternalBrowserSurface: BrowserSurfaceSummary | null;
  setSelectedExternalBrowserId: (id: string) => void;
}) {
  return (
    <div className="surface-card">
      <div className="section-head">
        <div>
          <div className="eyebrow">Browser lanes</div>
          <h2>Attach-first browser discovery</h2>
        </div>
        <span className={statusClass(browserInventory.surfaces.length ? 'running' : 'warning')}>
          {browserInventory.surfaces.length ? `${browserInventory.surfaces.length} discovered` : 'waiting'}
        </span>
      </div>
      <p className="muted">
        {browserInventory.surfaces.length
          ? `${browserInventory.sourceLabel}. Existing browser lanes can be attached later without inventing a new runtime session.`
          : 'CDP auto-probes http://127.0.0.1:9222. Playwright remains env-backed through CORTEX_BROWSER_PLAYWRIGHT_DISCOVERY_URL until we wire a concrete session publisher.'}
      </p>
      {browserInventory.surfaces.length ? (
        <div className="signal-stack">
          {browserInventory.surfaces.slice(0, 4).map((surface) => (
            <button
              key={`${surface.provider}:${surface.id}`}
              type="button"
              className={`agent-row ${surface.id === selectedExternalBrowserSurface?.id ? 'agent-row-active' : ''}`}
              onClick={() => setSelectedExternalBrowserId(surface.id)}
            >
              <div>
                <div className="agent-row-name">{browserSurfaceLabel(surface)}</div>
                <div className="agent-row-task">{browserProviderHint(surface) || surface.provider}</div>
                <div className="eyebrow top-gap-small">{browserCapabilityHint(surface)}</div>
              </div>
              <div className="agent-row-meta">
                <span className={statusClass(surface.status)}>{surface.status}</span>
                <span className="mono">{surface.provider}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <ul className="bullet-list muted top-gap">
          <li>Launch Chrome or Chromium with `--remote-debugging-port=9222` to expose CDP surfaces automatically.</li>
          <li>Set `CORTEX_BROWSER_CDP_DISCOVERY_URL` if your debugging endpoint is on a different localhost port.</li>
          <li>Set `CORTEX_BROWSER_PLAYWRIGHT_DISCOVERY_URL` when a local Playwright browser publisher is available.</li>
        </ul>
      )}
      {browserError ? <p className="muted operator-note">{browserError}</p> : null}
    </div>
  );
});

const ExternalBrowserInspectorCard = memo(function ExternalBrowserInspectorCard({
  browserInventory,
  browserError,
  selectedBrowserSurface,
  selectedExternalBrowserSurface,
  browserAttachState,
  browserAttachNote,
  onAttach,
}: {
  browserInventory: BrowserInventorySnapshot;
  browserError: string | null;
  selectedBrowserSurface: BrowserSurfaceSummary | null | undefined;
  selectedExternalBrowserSurface: BrowserSurfaceSummary | null;
  browserAttachState: 'idle' | 'attaching';
  browserAttachNote: string | null;
  onAttach: () => void;
}) {
  return (
    <>
      <div className="inset-card inspector-block">
        <div className="row space-between compact-row">
          <div>
            <span>Browser inventory</span>
            <strong>
              {browserInventory.surfaces.length
                ? `${browserInventory.surfaces.length} discovered browser lane${browserInventory.surfaces.length === 1 ? '' : 's'}`
                : 'No discovered browser lanes'}
            </strong>
          </div>
          <span className={statusClass(browserInventory.surfaces.length ? 'running' : 'warning')}>
            {browserInventory.surfaces.length ? 'attach-first' : 'idle'}
          </span>
        </div>
        <p className="muted">
          {browserInventory.sourceLabel}. Selected session: {browserSurfaceLabel(selectedBrowserSurface)}.
        </p>
        {browserInventory.surfaces.length ? (
          <ul className="bullet-list muted">
            {browserInventory.surfaces.slice(0, 4).map((surface) => (
              <li key={`${surface.provider}:${surface.id}`}>
                {surface.provider} • {surface.status} • {browserSurfaceLabel(surface)}{browserProviderHint(surface) ? ` • ${browserProviderHint(surface)}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
        {browserError ? <p className="muted operator-note">{browserError}</p> : null}
      </div>

      {selectedExternalBrowserSurface ? (
        <div className="inset-card inspector-block">
          <div className="row space-between compact-row">
            <div>
              <span>Selected external browser lane</span>
              <strong>{browserSurfaceLabel(selectedExternalBrowserSurface)}</strong>
            </div>
            <span className={statusClass(selectedExternalBrowserSurface.status)}>
              {selectedExternalBrowserSurface.provider}
            </span>
          </div>
          <p className="muted">
            Read-only attach target for a future browser session bridge. This does not steer anything yet and stays separate from the selected runtime session.
          </p>
          <div className="operator-actions queue-toolbar">
            <button
              type="button"
              className="button-primary"
              onClick={onAttach}
              disabled={browserAttachState !== 'idle'}
            >
              {browserAttachState === 'attaching' ? 'Attaching…' : 'Attach read-only'}
            </button>
          </div>
          <ul className="bullet-list muted">
            <li>{browserProviderHint(selectedExternalBrowserSurface) || 'Provider metadata unavailable'}</li>
            <li>{browserCapabilityHint(selectedExternalBrowserSurface)}</li>
            <li>{selectedExternalBrowserSurface.url ?? 'No URL exposed by provider'}</li>
            <li>{selectedExternalBrowserSurface.attachUrl ?? 'No attach URL exposed yet'}</li>
          </ul>
          {browserAttachNote ? <p className="muted operator-note">{browserAttachNote}</p> : null}
        </div>
      ) : null}
    </>
  );
});

const ReviewRailCard = memo(function ReviewRailCard({
  selectedAgentName,
  hasSessionSpecificEvents,
  visibleEvents,
  visibleArtifacts,
}: {
  selectedAgentName?: string;
  hasSessionSpecificEvents: boolean;
  visibleEvents: EventItem[];
  visibleArtifacts: FleetSnapshot['artifacts'];
}) {
  return (
    <div className="surface-card surface-card-tall">
      <div className="section-head">
        <div>
          <div className="eyebrow">Review rail</div>
          <h2>{selectedAgentName ? `${selectedAgentName} evidence` : 'Live events + artifacts'}</h2>
        </div>
        <span className="status-pill status-reviewing">{visibleArtifacts.length} artifacts</span>
      </div>
      <p className="muted operator-note">
        {hasSessionSpecificEvents
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
  );
});

const InspectorSidebar = memo(function InspectorSidebar({
  selectedAgent,
  selectedSquadName,
  selectedRuntimeSurface,
  inspectorTokenLabel,
  browserInventory,
  browserError,
  selectedBrowserSurface,
  selectedExternalBrowserSurface,
  browserAttachState,
  browserAttachNote,
  attachedBrowser,
  onAttachBrowserSurface,
  onRuntimeRefresh,
  realtimePrimary,
  onBeginOptimisticMutation,
  onSettleOptimisticMutation,
  fleetSourceLabel,
  primarySessionKey,
  isHydrated,
}: {
  selectedAgent: FleetSnapshot['agents'][number];
  selectedSquadName?: string;
  selectedRuntimeSurface: FleetSnapshot['agents'][number]['runtimeSurface'];
  inspectorTokenLabel: string;
  browserInventory: BrowserInventorySnapshot;
  browserError: string | null;
  selectedBrowserSurface: BrowserSurfaceSummary | null | undefined;
  selectedExternalBrowserSurface: BrowserSurfaceSummary | null;
  browserAttachState: 'idle' | 'attaching';
  browserAttachNote: string | null;
  attachedBrowser: BrowserAttachmentSummary | null;
  onAttachBrowserSurface: () => void;
  onRuntimeRefresh: (preferredId?: string) => Promise<unknown> | unknown;
  realtimePrimary: boolean;
  onBeginOptimisticMutation: (mutation: Omit<RealtimeMutationRecord, 'createdAt'>) => RealtimeMutationRecord;
  onSettleOptimisticMutation: (
    mutation: RealtimeMutationRecord,
    overrides: Partial<RealtimeMutationRecord>,
  ) => void;
  fleetSourceLabel: string;
  primarySessionKey?: string;
  isHydrated: boolean;
}) {
  const attachedBrowserTimeLabel = attachedBrowser?.attachedAt
    ? (!isHydrated
      ? attachedBrowser.attachedAt.slice(11, 16) || 'unknown'
      : new Date(attachedBrowser.attachedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
    : 'unknown';

  return (
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
        {selectedRuntimeSurface?.ownership === 'owned' ? (
          <>
            <div>
              <span>Lifecycle</span>
              <strong>{selectedRuntimeSurface.lifecycle?.availability ?? 'unknown'}</strong>
            </div>
            <div>
              <span>Last outcome</span>
              <strong>{selectedRuntimeSurface.lifecycle?.lastOutcome ?? 'none yet'}</strong>
            </div>
          </>
        ) : null}
      </div>

      <div className="inspector-block">
        <span>Runtime surface id</span>
        <strong className="mono">{selectedRuntimeSurface?.id ?? selectedAgent.sessionKey}</strong>
        <p className="muted">Session id: {selectedAgent.sessionId ?? 'unknown'}</p>
      </div>

      <div className="inspector-block">
        <span>Agent workspace</span>
        <strong>{selectedSquadName ?? 'Unassigned'}</strong>
        <p className="muted">{selectedAgent.workspace}</p>
      </div>

      <div className="inset-card inspector-block">
        <div className="row space-between compact-row">
          <div>
            <span>Runtime surface</span>
            <strong>
              {selectedRuntimeSurface?.sourceLabel ?? 'Runtime discovery'}
            </strong>
          </div>
          <span className={`status-pill ${selectedRuntimeSurface?.ownership === 'owned' ? 'status-healthy' : 'status-warning'}`}>
            {selectedRuntimeSurface?.ownership === 'owned' ? 'owned launch lane' : 'read-tail spike'}
          </span>
        </div>
        <ul className="bullet-list muted">
          {selectedRuntimeSurface?.ownership === 'owned' ? (
            <>
              <li>This Codex surface was launched by o8 and is tracked in the owned-session registry.</li>
              <li>Lifecycle now preserves current availability separately from last outcome.</li>
              <li>Input is truthful only between runs via resume; interrupt is truthful only while the run is active.</li>
              <li>The transport is JSON exec/resume, not fake keystroke injection into an arbitrary terminal.</li>
            </>
          ) : (
            <>
              <li>Codex surfaces now distinguish live pid-backed terminals from recent session history.</li>
              <li>Attach/read-tail are surfaced first because they are truthful right now.</li>
              <li>Only IDE-owned Codex surfaces may eventually become mutable; discovered terminals stay watch-only.</li>
              <li>Runtime depth should feel inside the product, not like a hostile terminal takeover.</li>
            </>
          )}
        </ul>
      </div>

      <ExternalBrowserInspectorCard
        browserInventory={browserInventory}
        browserError={browserError}
        selectedBrowserSurface={selectedBrowserSurface}
        selectedExternalBrowserSurface={selectedExternalBrowserSurface}
        browserAttachState={browserAttachState}
        browserAttachNote={browserAttachNote}
        onAttach={onAttachBrowserSurface}
      />

      {attachedBrowser ? (
        <div className="inset-card inspector-block">
          <div className="row space-between compact-row">
            <div>
              <span>Attached browser lane</span>
              <strong>{browserSurfaceLabel(attachedBrowser.surface)}</strong>
            </div>
            <span className={statusClass(attachedBrowser.surface.status)}>
              {attachedBrowser.provider}
            </span>
          </div>
          <p className="muted">
            {attachedBrowser.note ?? 'Read-only attach established.'}
          </p>
          <div className="stat-grid compact">
            <div>
              <span>Browser</span>
              <strong>{attachedBrowser.browserName ?? attachedBrowser.provider}</strong>
            </div>
            <div>
              <span>Version</span>
              <strong>{attachedBrowser.browserVersion ?? 'unknown'}</strong>
            </div>
            <div>
              <span>Pages</span>
              <strong>{attachedBrowser.pages.length}</strong>
            </div>
            <div>
              <span>Attached at</span>
              <strong>{attachedBrowserTimeLabel}</strong>
            </div>
          </div>
          <div className="event-stack top-gap">
            {attachedBrowser.pages.slice(0, 5).map((page) => (
              <div key={page.id} className="event-row">
                <div className="event-time">{page.status ?? 'page'}</div>
                <div>
                  <div className="event-title">{page.title ?? page.url ?? page.id}</div>
                  <div className="event-detail">{page.url ?? 'No page URL exposed'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <SessionOperatorPanel
        agent={selectedAgent}
        onRuntimeRefresh={onRuntimeRefresh}
        realtimePrimary={realtimePrimary}
        onBeginOptimisticMutation={onBeginOptimisticMutation}
        onSettleOptimisticMutation={onSettleOptimisticMutation}
      />

      <div className="inset-card inspector-block">
        <span>Runtime trace</span>
        <pre className="terminal-preview">
          {selectedRuntimeSurface?.ownership === 'owned'
              ? `$ POST /api/runtime/launch { runtime: "codex", cwd: "${selectedRuntimeSurface?.cwd ?? selectedAgent.workspace}", prompt: "..." }
> selected_surface=${selectedRuntimeSurface?.id ?? selectedAgent.sessionKey}
> source=${selectedRuntimeSurface?.sourceLabel ?? 'Owned Codex launch registry'}
> cwd=${selectedRuntimeSurface?.cwd ?? selectedAgent.workspace}
> branch=${selectedRuntimeSurface?.branch ?? selectedAgent.branch}
> ownership=${selectedRuntimeSurface?.ownership ?? 'owned'}
> tail_source=${selectedRuntimeSurface?.tailSourceLabel ?? '~/.cortex-ide/owned-codex/...'}

$ POST /api/runtime/action { action: "steer", surfaceId: "${selectedRuntimeSurface?.id ?? selectedAgent.sessionKey}", message: "..." }
$ POST /api/runtime/action { action: "stop", surfaceId: "${selectedRuntimeSurface?.id ?? selectedAgent.sessionKey}" }
$ GET /api/runtime/tail?surfaceId=${encodeURIComponent(selectedRuntimeSurface?.id ?? selectedAgent.sessionKey)}
> attach=${selectedRuntimeSurface?.capabilities.attach ? 'true' : 'false'}
> read_tail=${selectedRuntimeSurface?.capabilities.readTail ? 'true' : 'false'}
> send_input=${selectedRuntimeSurface?.capabilities.sendInput ? 'true' : 'false'}
> interrupt=${selectedRuntimeSurface?.capabilities.interrupt ? 'true' : 'false'}`
              : `$ sqlite3 -json ~/.codex/state_5.sqlite "select id,title,cwd,updated_at,rollout_path,git_branch,git_sha from threads order by updated_at desc limit 1;"
> selected_surface=${selectedRuntimeSurface?.id ?? selectedAgent.sessionKey}
> source=${selectedRuntimeSurface?.sourceLabel ?? 'Local Codex discovery'}
> cwd=${selectedRuntimeSurface?.cwd ?? selectedAgent.workspace}
> branch=${selectedRuntimeSurface?.branch ?? selectedAgent.branch}
> ownership=${selectedRuntimeSurface?.ownership ?? 'discovered'}
> tail_source=${selectedRuntimeSurface?.tailSourceLabel ?? '~/.codex/sessions/*.jsonl'}

$ GET /api/runtime/tail?surfaceId=${encodeURIComponent(selectedRuntimeSurface?.id ?? selectedAgent.sessionKey)}
> attach=${selectedRuntimeSurface?.capabilities.attach ? 'true' : 'false'}
> read_tail=${selectedRuntimeSurface?.capabilities.readTail ? 'true' : 'false'}
> send_input=${selectedRuntimeSurface?.capabilities.sendInput ? 'true' : 'false'}
> interrupt=${selectedRuntimeSurface?.capabilities.interrupt ? 'true' : 'false'}`}
        </pre>
      </div>
    </aside>
  );
});

export function CommandCenterShell({
  initialSnapshot,
  initialReview,
  initialBrowserInventory,
  initialAttachedBrowser,
  initialReviewError,
  initialBrowserError,
}: {
  initialSnapshot: FleetSnapshot;
  initialReview?: WorkflowReviewSnapshot | null;
  initialBrowserInventory?: BrowserInventorySnapshot;
  initialAttachedBrowser?: BrowserAttachmentSummary | null;
  initialReviewError?: string | null;
  initialBrowserError?: string | null;
}) {
  const realtimeStoreRef = useRef<RealtimeEntityStore | null>(null);
  if (!realtimeStoreRef.current) {
    realtimeStoreRef.current = new RealtimeEntityStore({
      fleet: initialSnapshot,
      review: initialReview ?? null,
      reviewError: initialReviewError ?? null,
      browserInventory: {
        generatedAt: initialBrowserInventory?.generatedAt ?? '',
        sourceLabel: initialBrowserInventory?.sourceLabel ?? 'Browser inventory loading…',
        surfaces: initialBrowserInventory?.surfaces ?? [],
      },
      attachedBrowser: initialAttachedBrowser ?? null,
      browserError: initialBrowserError ?? null,
      connection: {
        transport: 'connecting',
        realtimeState: deriveRealtimeHealth(initialSnapshot, initialReviewError, initialBrowserError),
        healthByChannel: deriveConnectionHealthByChannel(initialSnapshot, initialReviewError, initialBrowserError),
      },
    });
  }
  const realtimeStore = realtimeStoreRef.current;
  const realtimeState = useSyncExternalStore(
    realtimeStore.subscribe,
    realtimeStore.getState,
    realtimeStore.getState,
  );
  const fallbackBrowserInventory = useMemo<BrowserInventorySnapshot>(() => ({
    generatedAt: initialBrowserInventory?.generatedAt ?? '',
    sourceLabel: initialBrowserInventory?.sourceLabel ?? 'Browser inventory loading…',
    surfaces: initialBrowserInventory?.surfaces ?? [],
  }), [initialBrowserInventory]);
  const fleet = realtimeState.fleet ?? initialSnapshot;
  const review = realtimeState.review ?? initialReview ?? null;
  const reviewError = realtimeState.reviewError ?? initialReviewError ?? null;
  const browserInventory = realtimeState.browserInventory ?? fallbackBrowserInventory;
  const attachedBrowser = realtimeState.attachedBrowser ?? initialAttachedBrowser ?? null;
  const browserError = realtimeState.browserError ?? initialBrowserError ?? null;
  const [selectedId, setSelectedId] = useState(() => pickPreferredAgent(initialSnapshot));
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState(initialReview?.repoPath ?? process.cwd());
  const [launchPrompt, setLaunchPrompt] = useState('');
  const [launchState, setLaunchState] = useState<'idle' | 'launching'>('idle');
  const [launchNote, setLaunchNote] = useState<string | null>(null);
  const [selectedExternalBrowserId, setSelectedExternalBrowserId] = useState('');
  const [browserAttachState, setBrowserAttachState] = useState<'idle' | 'attaching'>('idle');
  const [browserAttachNote, setBrowserAttachNote] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const pendingRealtimeMutations = Object.values(realtimeState.mutations).filter((mutation) => !mutation.settledAt);
  const bootstrapRefreshNeeded = initialSnapshot.meta.mode !== 'live'
    || initialSnapshot.meta.gatewayFreshness !== 'fresh'
    || Boolean(initialSnapshot.meta.observablePending)
    || Boolean(initialReviewError)
    || Boolean(initialBrowserError);

  const realtimeCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      realtimeStore.applyEnvelope(event);
      setRefreshError(null);
    },
  }), [realtimeStore]);

  const {
    isConnected: realtimeConnected,
    connectionState: realtimeConnectionState,
  } = useSharedDesktopWs(undefined, realtimeCallbacks);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    realtimeStore.setTransport(
      realtimeConnectionState === 'connected'
        ? 'connected'
        : realtimeConnectionState === 'reconnecting'
          ? 'reconnecting'
          : realtimeConnectionState === 'connecting'
            ? 'connecting'
            : 'disconnected',
    );
  }, [realtimeConnectionState, realtimeStore]);
  const realtimePrimary = realtimeConnected && realtimeState.connection.realtimeState === 'live';

  useEffect(() => {
    setSelectedId((currentId) => pickPreferredAgent(fleet, currentId));
  }, [fleet]);

  useEffect(() => {
    if (review?.repoPath && !launchPrompt) {
      setLaunchCwd((current) => (current === process.cwd() ? review.repoPath ?? current : current));
    }
  }, [review?.repoPath, launchPrompt]);

  const refreshCommandCenterSnapshot = useCallback(async (
    preferredId?: string,
    options: { fresh?: boolean } = {},
  ) => {
    const startedGlobalSeq = realtimeStore.getState().streamSeq.global ?? 0;
    const query = options.fresh ? '?fresh=1' : '';
    const response = await fetch(`/api/command-center/bootstrap${query}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const nextBootstrap = (await response.json()) as CommandCenterBootstrapResponse;
    const nextSnapshot = nextBootstrap.snapshot;
    const currentGlobalSeq = realtimeStore.getState().streamSeq.global ?? 0;
    const shouldSkipReplace = currentGlobalSeq > startedGlobalSeq
      && realtimeStore.getState().connection.transport === 'connected';
    if (shouldSkipReplace) {
      return nextSnapshot;
    }
    const currentState = realtimeStore.getState();
    const currentSnapshot: CommandCenterSnapshot = {
      fleet: currentState.fleet ?? initialSnapshot,
      review: currentState.review ?? initialReview ?? null,
      reviewError: currentState.reviewError ?? initialReviewError ?? null,
      browserInventory: currentState.browserInventory ?? fallbackBrowserInventory,
      attachedBrowser: currentState.attachedBrowser ?? initialAttachedBrowser ?? null,
      browserError: currentState.browserError ?? initialBrowserError ?? null,
    };
    if (shouldRetainCurrentCommandCenterSnapshot(currentSnapshot, nextBootstrap)) {
      return currentSnapshot;
    }
    realtimeStore.replace({
      fleet: nextSnapshot.fleet,
      review: nextSnapshot.review,
      reviewError: nextSnapshot.reviewError ?? null,
      browserInventory: nextSnapshot.browserInventory,
      attachedBrowser: nextSnapshot.attachedBrowser,
      browserError: nextSnapshot.browserError ?? null,
      connection: {
        ...realtimeStore.getState().connection,
        realtimeState: deriveRealtimeHealth(nextSnapshot.fleet, nextSnapshot.reviewError, nextSnapshot.browserError),
        healthByChannel: deriveConnectionHealthByChannel(nextSnapshot.fleet, nextSnapshot.reviewError, nextSnapshot.browserError),
      },
    });
    setRefreshError(null);
    if (preferredId && nextSnapshot.fleet.agents.some((agent) => agent.id === preferredId)) {
      setSelectedId(preferredId);
    }
    return nextSnapshot;
  }, [
    fallbackBrowserInventory,
    initialAttachedBrowser,
    initialBrowserError,
    initialReview,
    initialReviewError,
    initialSnapshot,
    realtimeStore,
  ]);

  useEffect(() => {
    let active = true;

    async function refreshCommandCenterSnapshotLoop() {
      try {
        await refreshCommandCenterSnapshot(undefined, { fresh: !realtimePrimary });
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh live fleet');
      }
    }

    if (!realtimePrimary) {
      void refreshCommandCenterSnapshotLoop();
    }

    const timer = window.setInterval(() => {
      void refreshCommandCenterSnapshotLoop();
    }, realtimePrimary ? 120_000 : 15_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshCommandCenterSnapshot, realtimePrimary]);

  useEffect(() => {
    if (!bootstrapRefreshNeeded) return;
    let active = true;

    async function refreshSoon() {
      try {
        await refreshCommandCenterSnapshot(undefined, { fresh: true });
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh live fleet');
      }
    }

    void refreshSoon();
    const timer = window.setTimeout(() => {
      if (active) void refreshSoon();
    }, 2500);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [bootstrapRefreshNeeded, refreshCommandCenterSnapshot]);

  useEffect(() => {
    setSelectedExternalBrowserId((currentId) => pickPreferredBrowserSurface(browserInventory, currentId));
  }, [browserInventory]);

  const selectedAgent = useMemo(
    () => fleet.agents.find((agent) => agent.id === selectedId) ?? fleet.agents[0],
    [fleet, selectedId],
  );
  const selectedRuntimeSurface = selectedAgent?.runtimeSurface;
  const selectedBrowserSurface = selectedAgent?.browserSurface ?? selectedRuntimeSurface?.browserSurface;
  const selectedExternalBrowserSurface = useMemo(
    () => browserInventory.surfaces.find((surface) => surface.id === selectedExternalBrowserId) ?? browserInventory.surfaces[0] ?? null,
    [browserInventory, selectedExternalBrowserId],
  );

  const desktopInfo =
    isHydrated && typeof window !== 'undefined'
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
  const selectedEvents = useMemo(
    () => selectedAgent
      ? fleet.events.filter((event) => event.agentId === selectedAgent.id)
      : [],
    [fleet.events, selectedAgent],
  );
  const selectedArtifacts = useMemo(
    () => selectedAgent
      ? fleet.artifacts.filter((artifact) => !artifact.agentId || artifact.agentId === selectedAgent.id)
      : fleet.artifacts,
    [fleet.artifacts, selectedAgent],
  );
  const visibleEvents = useMemo(
    () => selectedEvents.length ? selectedEvents : fleet.events,
    [fleet.events, selectedEvents],
  );
  const visibleArtifacts = useMemo(
    () => selectedArtifacts.length ? selectedArtifacts : fleet.artifacts,
    [fleet.artifacts, selectedArtifacts],
  );

  const inspectorTokenLabel = selectedAgent?.tokenUsage?.totalTokens
    ? `${formatTokenUsage(selectedAgent.tokenUsage.totalTokens)} used`
    : '—';

  const beginOptimisticMutation = useCallback((mutation: Omit<RealtimeMutationRecord, 'createdAt'>) => {
    const record: RealtimeMutationRecord = {
      ...mutation,
      createdAt: new Date().toISOString(),
    };
    realtimeStore.beginMutation(record);
    return record;
  }, [realtimeStore]);

  const settleOptimisticMutation = useCallback((
    mutation: RealtimeMutationRecord,
    overrides: Partial<RealtimeMutationRecord>,
  ) => {
    realtimeStore.settleMutation({
      ...mutation,
      ...overrides,
      settledAt: new Date().toISOString(),
      optimistic: false,
    });
  }, [realtimeStore]);

  async function handleOwnedCodexLaunch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!launchPrompt.trim()) return;

    setLaunchState('launching');
    setLaunchNote(null);
    const mutation = beginOptimisticMutation({
      mutationId: createMutationId(),
      source: 'desktop',
      action: 'launch',
      runtime: 'codex',
      surfaceId: launchCwd,
      note: `Launching owned Codex in ${launchCwd}`,
      optimistic: true,
      status: 'pending',
    });

    try {
      const response = await fetch('/api/runtime/launch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          runtime: 'codex',
          cwd: launchCwd,
          prompt: launchPrompt,
          clientMutationId: mutation.mutationId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        surfaceId?: string;
        note?: string;
        error?: string;
        clientMutationId?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }

      setLaunchPrompt('');
      setLaunchNote(payload?.note ?? 'Owned Codex run launched.');
      settleOptimisticMutation(mutation, {
        status: 'queued',
        surfaceId: payload?.surfaceId ?? mutation.surfaceId,
        note: payload?.note ?? mutation.note,
      });
      if (!realtimePrimary) {
        await refreshCommandCenterSnapshot(payload?.surfaceId, { fresh: true });
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : 'Unable to launch owned Codex session';
      settleOptimisticMutation(mutation, { status: 'failed', note });
      setLaunchNote(note);
    } finally {
      setLaunchState('idle');
    }
  }

  const handleAttachBrowserSurface = useCallback(async () => {
    if (!selectedExternalBrowserSurface) return;

    setBrowserAttachState('attaching');
    setBrowserAttachNote(null);

    try {
      const response = await fetch('/api/browser/attach', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: selectedExternalBrowserSurface.provider,
          surfaceId: selectedExternalBrowserSurface.id,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        attachment?: BrowserAttachmentSummary;
        error?: string;
      } | null;

      if (!response.ok || !payload?.attachment) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }

      realtimeStore.replace({
        ...realtimeStore.getState(),
        attachedBrowser: payload.attachment,
      });
      setBrowserAttachNote(payload.attachment.note ?? 'Browser lane attached in read-only mode.');
    } catch (error) {
      setBrowserAttachNote(error instanceof Error ? error.message : 'Unable to attach browser lane');
    } finally {
      setBrowserAttachState('idle');
    }
  }, [realtimeStore, selectedExternalBrowserSurface]);

  return (
    <div className="page-wrap">
      <div className="announcement-bar">
        <span className={statusClass(fleet.meta.mode === 'live' ? 'healthy' : 'warning')}>
          {fleet.meta.mode === 'live' ? 'live runtime inventory' : 'demo fallback'}
        </span>
        <span className={statusClass(realtimeConnected ? (realtimeState.connection.realtimeState === 'live' ? 'healthy' : 'warning') : 'warning')}>
          {realtimeConnected ? `realtime ${realtimeState.connection.realtimeState}` : 'realtime fallback'}
        </span>
        {pendingRealtimeMutations.length ? (
          <span className={statusClass('reviewing')}>
            {pendingRealtimeMutations.length} local action{pendingRealtimeMutations.length === 1 ? '' : 's'} reconciling
          </span>
        ) : null}
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
              <div className="eyebrow">o8</div>
              <h1>Live runtime command center</h1>
            </div>
          </div>
          <p className="hero-copy">
            Surface live Codex and Claude Code sessions inside one control plane without pretending the UI owns work it did not launch. New sessions belong behind explicit spawn actions, not silent UI side effects.
          </p>
        </div>
        <div className="command-strip">
          {reviewPullRequest ? (
            <a href={reviewPullRequest.url} target="_blank" rel="noreferrer">
              <button>{`PR #${reviewPullRequest.number}`}</button>
            </a>
          ) : null}
          <a href={`https://github.com/${review?.repoSlug ?? ''}/issues`} target="_blank" rel="noreferrer">
            <button>Issues</button>
          </a>
          <button type="button" onClick={() => window.location.reload()}>
            Refresh
          </button>
          <a href="/mobile" rel="noreferrer">
            <button className="button-primary">Mobile remote</button>
          </a>
          <a href="/dashboard" rel="noreferrer">
            <button className="button-primary" style={{ background: 'linear-gradient(135deg, #60a5fa, #a78bfa)' }}>Dashboard v1 →</button>
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
                <div className="agent-row-meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={statusClass(agent.status)}>{agent.status}</span>
                  <ContextUsageRing percent={agent.context.usedPercent} size={26} />
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
                  ? `Desktop ${desktopInfo.version} on ${desktopInfo.platform}`
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
                  <strong>{review?.repoSlug ?? ''}</strong>
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

            <BrowserDiscoveryCard
              browserInventory={browserInventory}
              browserError={browserError}
              selectedExternalBrowserSurface={selectedExternalBrowserSurface}
              setSelectedExternalBrowserId={setSelectedExternalBrowserId}
            />
          </div>

          <div className="canvas-grid">
            <div className="surface-card surface-card-tall">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Overview</div>
                  <h2>Live runtime inventory</h2>
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
                    The live bridge should show what the active local runtimes are already doing. Spawning belongs behind an explicit action so the UI never creates ghost work or fake context.
                  </p>
                  <ul className="bullet-list muted">
                    <li>Primary mirror: {fleet.meta.primarySessionKey ?? 'unknown'}</li>
                    <li>Mode: {fleet.meta.mirrorMode}</li>
                    <li>Alerts across visible surfaces: {alertCount}</li>
                  </ul>
                  <div className="top-gap">
                    <div className="eyebrow">Owned Codex launch</div>
                    <p className="muted operator-note">
                      This is the first truthful mutable Codex lane: o8 launches the session,
                      tracks ownership, resumes it between runs, and can interrupt the active process.
                    </p>
                    <form className="operator-form" onSubmit={handleOwnedCodexLaunch}>
                      <input
                        className="operator-textarea"
                        value={launchCwd}
                        onChange={(event) => setLaunchCwd(event.target.value)}
                        placeholder="~/projects/my-app"
                      />
                      <textarea
                        className="operator-textarea"
                        value={launchPrompt}
                        onChange={(event) => setLaunchPrompt(event.target.value)}
                        rows={4}
                        placeholder="Launch an IDE-owned Codex run with a bounded task…"
                      />
                      <div className="operator-actions queue-toolbar">
                        <button className="button-primary" type="submit" disabled={launchState !== 'idle' || !launchPrompt.trim()}>
                          {launchState === 'launching' ? 'Launching…' : 'Launch owned Codex'}
                        </button>
                      </div>
                    </form>
                    {launchNote ? <p className="muted operator-note">{launchNote}</p> : null}
                  </div>
                </div>
              </div>
            </div>

            <ReviewRailCard
              selectedAgentName={selectedAgent?.name}
              hasSessionSpecificEvents={selectedEvents.length > 0}
              visibleEvents={visibleEvents}
              visibleArtifacts={visibleArtifacts}
            />
          </div>

          <WorkflowReviewPanel
            initialSnapshot={review}
            controlled
            error={reviewError}
            onRefresh={() => refreshCommandCenterSnapshot(selectedId, { fresh: true })}
          />
        </section>

        {selectedAgent ? (
          <InspectorSidebar
            selectedAgent={selectedAgent}
            selectedSquadName={selectedSquad?.name}
            selectedRuntimeSurface={selectedRuntimeSurface}
            inspectorTokenLabel={inspectorTokenLabel}
            browserInventory={browserInventory}
            browserError={browserError}
            selectedBrowserSurface={selectedBrowserSurface}
            selectedExternalBrowserSurface={selectedExternalBrowserSurface}
            browserAttachState={browserAttachState}
            browserAttachNote={browserAttachNote}
            attachedBrowser={attachedBrowser}
            onAttachBrowserSurface={() => { void handleAttachBrowserSurface(); }}
            onRuntimeRefresh={refreshCommandCenterSnapshot}
            realtimePrimary={realtimePrimary}
            onBeginOptimisticMutation={beginOptimisticMutation}
            onSettleOptimisticMutation={settleOptimisticMutation}
            fleetSourceLabel={fleet.meta.sourceLabel}
            primarySessionKey={fleet.meta.primarySessionKey}
            isHydrated={isHydrated}
          />
        ) : null}
      </main>
    </div>
  );
}
