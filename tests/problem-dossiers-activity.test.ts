// jsdom ships here as a transitive test dependency without declarations.
// @ts-expect-error test-only module has no bundled types
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { O8ProblemDossiers } from '@/components/desktop/o8-panel/O8ProblemDossiers';
import { O8InboxPane } from '@/components/desktop/O8InboxPane';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/dashboard',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

function dossier(status: 'candidate' | 'accepted') {
  return {
    schema: 'o8/problem-dossier/v1',
    id: 'problem-ui',
    fingerprint: 'stable-fingerprint',
    projectId: 'project-ui',
    repoPath: '/tmp/repo-ui',
    painStatement: 'verification failed in three independent packets',
    firstObservedAt: '2026-08-13T10:00:00.000Z',
    lastObservedAt: '2026-08-13T12:00:00.000Z',
    occurrenceCount: 3,
    observedDurationMs: 7_200_000,
    comparableExposureCount: 0,
    impactBand: 'moderate',
    evidenceConfidence: 'high',
    status,
    closureContract: {
      kind: 'supervisor_incident_absence',
      sourceKind: 'verification_failed',
      baseline: { occurrenceCount: 3, distinctAttempts: 3, recordedAt: '2026-08-13T12:00:00.000Z' },
      exposureDenominator: 'distinct_reviewed_releases',
      requiredComparableExposures: 3,
    },
    suppressedAt: null,
    cooldownUntil: null,
    acceptedAt: status === 'accepted' ? '2026-08-13T13:00:00.000Z' : null,
    linkedTaskId: status === 'accepted' ? 'pkt-remedy-ui' : null,
    provisionalResolvedAt: null,
    verifiedClosedAt: null,
    reopenedAt: null,
    operatorStoppedAt: null,
    suppressionReason: null,
    recurrenceProposalId: null,
    lastError: null,
    createdAt: '2026-08-13T12:00:00.000Z',
    updatedAt: '2026-08-13T13:00:00.000Z',
    evidence: [{
      id: 'evidence-ui',
      dossierId: 'problem-ui',
      sourceType: 'supervisor_inbox',
      sourceId: 'incident-ui',
      sourceKind: 'verification_failed',
      packetId: 'pkt-source-ui',
      observedAt: '2026-08-13T12:00:00.000Z',
    }],
    history: status === 'accepted' ? [{
      id: 'event-ui',
      dossierId: 'problem-ui',
      eventType: 'remedy_accepted',
      actor: 'operator',
      note: 'Created linked task pkt-remedy-ui.',
      fromStatus: 'candidate',
      toStatus: 'accepted',
      at: '2026-08-13T13:00:00.000Z',
    }] : [],
    remedies: status === 'accepted' ? [{
      id: 'remedy-ui',
      dossierId: 'problem-ui',
      sequence: 1,
      taskId: 'pkt-remedy-ui',
      missionId: 'mission-ui',
      packetId: 'pkt-remedy-ui',
      laneId: null,
      approvalId: null,
      reviewId: null,
      releaseRef: null,
      status: 'accepted',
      createdAt: '2026-08-13T13:00:00.000Z',
      updatedAt: '2026-08-13T13:00:00.000Z',
    }] : [],
  };
}

function supervisorItem(id: string, problemDossierId: string | null): SupervisorInboxItem {
  return {
    id,
    projectId: 'project-ui',
    repoPath: '/tmp/repo-ui',
    packetId: `pkt-${id}`,
    kind: 'packet_no_changes',
    incidentKey: `incident-${id}`,
    payload: { note: 'Archived without a recorded ending' },
    createdAt: '2026-08-13T12:00:00.000Z',
    lastSeenAt: '2026-08-13T12:00:00.000Z',
    repeatCount: 1,
    status: 'human_required',
    resolvedAt: null,
    resolutionLaneId: null,
    packetTitle: `${id} incident`,
    packetReferenceLabel: null,
    sessionKey: null,
    worktreePath: '/tmp/repo-ui',
    transcriptLink: null,
    worktreeLink: 'file:///tmp/repo-ui',
    errorExcerpt: 'Archived without a recorded ending',
    problemDossierId,
  };
}

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '<div id="root"></div>';
});

describe('Activity recurring-problem surface', () => {
  it('shows exact evidence and routes Accept into one linked ordinary task', async () => {
    let accepted = false;
    let postCount = 0;
    const fetchMock = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, inProgress: true }), { status: 202 }));
        }
        accepted = true;
        return Promise.resolve(new Response(JSON.stringify({ ok: true, dossier: dossier('accepted') }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        schema: 'o8/problem-dossiers/v1',
        dossiers: [dossier(accepted ? 'accepted' : 'candidate')],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing test root.');
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(O8ProblemDossiers, { active: true, repoPath: '/tmp/repo-ui' }));
    });
    expect(container.textContent).toContain('Recurring problems');
    expect(container.textContent).toContain('verification failed in three independent packets');
    expect(container.textContent).toContain('3 signals');

    const accept = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept');
    if (!accept) throw new Error('Accept button was not rendered.');
    await act(async () => {
      accept.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 850));
    });
    expect(container.textContent).toContain('Accepted');

    const inspect = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Inspect history');
    if (!inspect) throw new Error('Inspect history button was not rendered.');
    await act(async () => inspect.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Task pkt-remedy-ui');
    expect(container.textContent).toContain('remedy accepted');
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      action: 'accept',
      dossierId: 'problem-ui',
      clientMutationId: expect.any(String),
    });
    const postBodies = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      .map(([, init]) => String((init as RequestInit).body));
    expect(postBodies).toHaveLength(2);
    expect(new Set(postBodies).size).toBe(1);
  });

  it('keeps correlated source incidents out of the competing Incident Queue', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/panel/approvals')) {
        return Promise.resolve(new Response(JSON.stringify({ approvals: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        items: [
          supervisorItem('dossier-source', 'problem-ui'),
          supervisorItem('unlinked-source', null),
        ],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing test root.');
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(O8InboxPane, { active: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.textContent).toContain('unlinked-source incident');
    expect(container.textContent).not.toContain('dossier-source incident');
    expect(container.textContent).toContain('Active · 1');
  });
});
